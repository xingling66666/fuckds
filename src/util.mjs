import { ApiError } from './errors.mjs';
import { countTokens } from './tokenizer.mjs';

const TEXT_PART_TYPES = new Set(['text', 'input_text']);
const IMAGE_PART_TYPES = new Set(['image_url', 'input_image', 'image']);

/**
 * 从 OpenAI content（string 或 parts 数组）里取文本。
 * 网页版输入框只能塞纯文本，图片/音频直接报错，避免静默丢内容。
 */
export function contentToText(content, role = 'user') {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    throw new ApiError(400, `messages 中 ${role} 的 content 类型不支持: ${typeof content}`, {
      code: 'invalid_content',
    });
  }
  const chunks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = part.type || (part.text !== undefined ? 'text' : '');
    if (TEXT_PART_TYPES.has(type) || typeof part.text === 'string') {
      if (typeof part.text === 'string') chunks.push(part.text);
      continue;
    }
    if (IMAGE_PART_TYPES.has(type)) {
      // 图片由 normalizeChatRequest 单独收集，这里只取文本
      continue;
    }
    throw new ApiError(400, `不支持的 content part 类型: ${type}`, { code: 'unsupported_content' });
  }
  return chunks.join('\n');
}

/**
 * token 计数：按仓库根目录的 `tokenizer.json`（128k BPE）真分词。
 *
 * 以前这里是"中文 1 字 1 token + 其它 4 字符 1 token"的估算，误差能到 ±40%，
 * 客户端按 usage 计费 / 截断上下文都会偏。现在走真实词表（见 src/tokenizer.mjs）。
 *
 * tokenizer.json 读不到时（部署漏拷该文件）自动回退到旧的估算口径，
 * 并且只尝试一次 —— 不让每条请求都去抛一次异常。
 */
let tokenizerBroken = false;

export function estimateTokens(text) {
  if (!text) return 0;
  if (!tokenizerBroken) {
    try {
      return countTokens(text);
    } catch {
      tokenizerBroken = true;
    }
  }
  return legacyEstimateTokens(text);
}

/** 旧口径（仅作回退）：中文按 1 字 1 token，其余按 4 字符 1 token */
function legacyEstimateTokens(text) {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

/**
 * 解析 .env 文本：config.mjs（启动加载）和 admin/routes.mjs（后台读配置）
 * 原来各写了一份，且对引号/注释的处理要保持一致，抽到这里。
 * 返回键值对象；不处理 export 前缀以外的 shell 语法，和原来保持一致。
 */
export function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function withTimeout(promise, ms, message = 'operation timed out') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
