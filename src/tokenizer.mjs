import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 真实 token 计数：直接按仓库根目录的 `tokenizer.json`（128k BPE）分词。
 *
 * 以前 usage 里的 token 数是"中文 1 字 1 token + 其它 4 字符 1 token"估出来的，
 * 误差能到 ±40%，客户端按它算钱 / 截断上下文都会出问题。这里按词表真分词。
 *
 * 覆盖 tokenizer.json 里用到的全部环节：
 *   normalizer    : 空的 Sequence（不归一化）
 *   pre_tokenizer : Split(数字 1-3 位) → Split(中文/日文假名) → Split(GPT-4 式混合正则)
 *                   → ByteLevel(add_prefix_space=false, use_regex=false)
 *   model         : BPE + merges rank（byte_fallback）
 *   added_tokens  : 特殊 token 各算 1 个
 *
 * 6MB 的 JSON 只解析一次（懒加载），之后全进程共用。
 */

let cached = null;

function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i += 1) bs.push(i);
  for (let i = 161; i <= 172; i += 1) bs.push(i);
  for (let i = 174; i <= 255; i += 1) bs.push(i);

  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b += 1) {
    if (bs.includes(b)) continue;
    bs.push(b);
    cs.push(256 + n);
    n += 1;
  }

  const encode = new Map();
  const decode = new Map();
  for (let i = 0; i < bs.length; i += 1) {
    const ch = String.fromCodePoint(cs[i]);
    encode.set(bs[i], ch);
    decode.set(ch, bs[i]);
  }
  return { encode, decode };
}

/** HuggingFace 的 Split(behavior=Isolated)：匹配段独立成片，其余保留 */
function splitIsolated(text, re) {
  const parts = [];
  let last = 0;
  re.lastIndex = 0;
  for (;;) {
    const match = re.exec(text);
    if (!match) break;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(match[0]);
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex += 1;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.filter((part) => part.length > 0);
}

/** tokenizer.json 里的三个 Split 预分词（顺序不能动） */
const SPLIT_PATTERNS = [
  /\p{N}{1,3}/gu,
  /[\u4e00-\u9fa5\u3040-\u309f\u30a0-\u30ff]+/gu,
  /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~][A-Za-z]+|[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+| ?[\p{P}\p{S}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu,
];

let SPECIAL_SET = new Set();

function loadTokenizer() {
  if (cached) return cached;
  const file = process.env.TOKENIZER_PATH || path.join(ROOT, 'tokenizer.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));

  const vocab = new Map(Object.entries(raw.model.vocab));
  const idToToken = new Map();
  for (const [token, id] of vocab) idToToken.set(id, token);

  const ranks = new Map();
  const merges = raw.model.merges || [];
  for (let i = 0; i < merges.length; i += 1) {
    const pair = Array.isArray(merges[i]) ? merges[i].join(' ') : merges[i];
    ranks.set(pair, i);
  }

  const specials = (raw.added_tokens || []).map((token) => token.content).filter(Boolean);
  SPECIAL_SET = new Set(specials);
  const specialRe = specials.length
    ? new RegExp(`(${specials.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gu')
    : null;

  const { encode: byteEncoder, decode: byteDecoder } = bytesToUnicode();
  cached = { vocab, idToToken, ranks, specialRe, byteEncoder, byteDecoder };
  return cached;
}

/** 一个预分词片段 → id 数组（GPT-2 风格 BPE） */
function bpeTokenize(piece, { vocab, ranks, byteEncoder }) {
  const bytes = Buffer.from(piece, 'utf8');
  let word = [];
  for (const b of bytes) {
    const ch = byteEncoder.get(b);
    if (ch === undefined) return [];
    word.push(ch);
  }
  if (!word.length) return [];

  if (word.length === 1) {
    const id = vocab.get(word[0]);
    return id === undefined ? [] : [id];
  }

  const whole = vocab.get(word.join(''));
  if (whole !== undefined) return [whole];

  const pairsOf = (chars) => {
    const pairs = new Set();
    for (let i = 0; i < chars.length - 1; i += 1) pairs.add(`${chars[i]} ${chars[i + 1]}`);
    return pairs;
  };

  let pairs = pairsOf(word);
  for (;;) {
    let best = null;
    let bestRank = Infinity;
    for (const pair of pairs) {
      const rank = ranks.get(pair);
      if (rank !== undefined && rank < bestRank) {
        best = pair;
        bestRank = rank;
      }
    }
    if (best === null) break;

    const [left, right] = best.split(' ');
    const merged = [];
    for (let i = 0; i < word.length; i += 1) {
      if (i < word.length - 1 && word[i] === left && word[i + 1] === right) {
        merged.push(left + right);
        i += 1;
      } else {
        merged.push(word[i]);
      }
    }
    word = merged;
    if (word.length === 1) break;
    pairs = pairsOf(word);
  }

  const ids = [];
  for (const part of word) {
    const id = vocab.get(part);
    if (id !== undefined) ids.push(id);
  }
  if (!ids.length) {
    for (const ch of word) {
      const id = vocab.get(ch);
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
}

function encodePlain(text, state) {
  let pieces = [text];
  for (const pattern of SPLIT_PATTERNS) {
    pieces = pieces.flatMap((piece) => splitIsolated(piece, pattern));
  }
  const ids = [];
  for (const piece of pieces) ids.push(...bpeTokenize(piece, state));
  return ids;
}

/**
 * 把文本编码成 token id 数组（特殊 token 各占一个 id：用词表里的 id，查不到则跳过）。
 * @param {string} text
 * @returns {number[]}
 */
export function encode(text) {
  if (!text) return [];
  const state = loadTokenizer();
  const source = String(text);
  if (!source) return [];

  if (!state.specialRe) return encodePlain(source, state);

  const ids = [];
  for (const part of source.split(state.specialRe)) {
    if (!part) continue;
    if (SPECIAL_SET.has(part)) {
      const id = state.vocab.get(part);
      if (id !== undefined) ids.push(id);
      continue;
    }
    ids.push(...encodePlain(part, state));
  }
  return ids;
}

/**
 * 数一条文本有多少 token。
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  return encode(text).length;
}

/** 把 id 还原成文本（round-trip 自检用） */
export function decode(ids) {
  const state = loadTokenizer();
  const chunks = [];
  for (const id of ids) {
    const token = state.idToToken.get(id);
    if (token === undefined) continue;
    if (SPECIAL_SET.has(token)) {
      chunks.push(Buffer.from(token, 'utf8'));
      continue;
    }
    const bytes = [];
    for (const ch of token) {
      const b = state.byteDecoder.get(ch);
      if (b !== undefined) bytes.push(b);
    }
    chunks.push(Buffer.from(bytes));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 诊断用：词表规模 */
export function tokenizerInfo() {
  const state = loadTokenizer();
  return { vocabSize: state.vocab.size, merges: state.ranks.size, specials: SPECIAL_SET.size };
}
