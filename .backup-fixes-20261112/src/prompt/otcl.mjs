/**
 * OTCL（Opends Tool Call Language）解析。
 *
 * 模型像写 JavaScript 一样调用工具，但**只有包在 `<!OTCL>...</OTCL>` 里的文本才算工具调用**：
 *
 *   <!OTCL>
 *   exec_shell({command:"uname -a", timeout:10});
 *   read_file({path:"/etc/hosts"});
 *   -OTCL
 *
 * 这样用户让模型写普通 JS 代码时（代码在标记外面），不会被误判成工具调用；
 * 反过来，模型写在标记外面的任何内容都按普通正文处理。
 *
 * 这里把 JS 对象字面量解析成普通值（**不 eval**），再交给上层转成标准
 * tool_calls.arguments（合法 JSON 字符串）。支持的 JS 字面量：
 * - 对象 / 数组；键可以是裸标识符、单/双引号字符串或数字；
 * - 字符串单双引号、反引号（不处理 ${} 插值，原样当文本）；常见反斜杠转义；
 * - 数字（十进制 / 小数 / 指数 / 0x 十六进制）、true / false / null / undefined；
 * - 尾逗号；// 与 /* *\/ 注释；
 * - 裸单词值（例如 command: ls）当字符串处理，容错模型的常见写法。
 *
 * 工具调用也可能被截断（流式最后半句 / 输出上限 / 块没闭合），解析器会尽量把
 * 已经完整的参数解析出来，未闭合的括号在块尾收尾。
 */

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CONT = /[\w$]/;
const NUMBER_RE = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/;
/** 行首允许的 markdown 装饰：`- ` / `* ` / `> ` / `1. ` */
const LINE_DECOR = /^(?:(?:[-*+>]|\d+\.)[ \t]+)?[ \t]*/;

/** 块标记：`!OTCL` ... `-OTCL`（大小写不敏感） */
const BLOCK_OPEN = /!OTCL/i;
const BLOCK_CLOSE = /-OTCL/i;

class Reader {
  constructor(text, index = 0) {
    this.text = text;
    this.i = index;
  }

  get len() {
    return this.text.length;
  }

  skipTrivia() {
    const text = this.text;
    for (;;) {
      while (this.i < this.len && /\s/.test(text[this.i])) this.i += 1;
      if (text[this.i] === '/' && text[this.i + 1] === '/') {
        const newline = text.indexOf('\n', this.i + 2);
        this.i = newline === -1 ? this.len : newline + 1;
        continue;
      }
      if (text[this.i] === '/' && text[this.i + 1] === '*') {
        const close = text.indexOf('*/', this.i + 2);
        this.i = close === -1 ? this.len : close + 2;
        continue;
      }
      break;
    }
  }

  /** @returns {{ ok: boolean, value?: any, partial?: boolean }} */
  parseValue() {
    this.skipTrivia();
    if (this.i >= this.len) return { ok: true, value: undefined, partial: true };
    const ch = this.text[this.i];
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"' || ch === "'" || ch === '`') return this.parseString(ch);
    if (ch === '-' || ch === '+' || ch === '.' || /[0-9]/.test(ch)) return this.parseNumber();
    if (IDENT_START.test(ch)) return this.parseWord();
    return { ok: false };
  }

  parseObject() {
    const text = this.text;
    this.i += 1; // {
    const value = Object.create(null);
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.len) return { ok: true, value, partial: true };
      if (text[this.i] === '}') {
        this.i += 1;
        return { ok: true, value, closed: true };
      }

      let key;
      const ch = text[this.i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const parsed = this.parseString(ch);
        if (!parsed.ok || parsed.partial) return { ok: true, value, partial: true };
        key = parsed.value;
      } else if (IDENT_START.test(ch) || /[0-9]/.test(ch)) {
        const start = this.i;
        while (this.i < this.len && (IDENT_CONT.test(text[this.i]) || text[this.i] === '.' || text[this.i] === '-')) {
          this.i += 1;
        }
        key = text.slice(start, this.i);
      } else {
        return { ok: false };
      }

      this.skipTrivia();
      if (text[this.i] !== ':') {
        if (this.i >= this.len) return { ok: true, value, partial: true };
        return { ok: false };
      }
      this.i += 1;

      const parsed = this.parseValue();
      if (!parsed.ok) return { ok: false };
      if (parsed.partial) return { ok: true, value, partial: true };
      value[key] = parsed.value;

      this.skipTrivia();
      if (text[this.i] === ',') {
        this.i += 1;
        continue;
      }
      if (text[this.i] === '}') {
        this.i += 1;
        return { ok: true, value, closed: true };
      }
      if (this.i >= this.len) return { ok: true, value, partial: true };
      return { ok: false };
    }
  }

  parseArray() {
    const text = this.text;
    this.i += 1; // [
    const value = [];
    for (;;) {
      this.skipTrivia();
      if (this.i >= this.len) return { ok: true, value, partial: true };
      if (text[this.i] === ']') {
        this.i += 1;
        return { ok: true, value, closed: true };
      }
      const parsed = this.parseValue();
      if (!parsed.ok) return { ok: false };
      if (parsed.partial) return { ok: true, value, partial: true };
      value.push(parsed.value);
      this.skipTrivia();
      if (text[this.i] === ',') {
        this.i += 1;
        continue;
      }
      if (text[this.i] === ']') {
        this.i += 1;
        return { ok: true, value, closed: true };
      }
      if (this.i >= this.len) return { ok: true, value, partial: true };
      return { ok: false };
    }
  }

  parseString(quote) {
    const text = this.text;
    this.i += 1;
    let out = '';
    while (this.i < this.len) {
      const ch = text[this.i];
      if (ch === quote) {
        this.i += 1;
        return { ok: true, value: out };
      }
      if (ch === '\\') {
        this.i += 1;
        if (this.i >= this.len) break;
        out += this.readEscape();
        continue;
      }
      out += ch;
      this.i += 1;
    }
    // EOF：字符串没闭合，值不完整
    return { ok: true, value: out, partial: true };
  }

  readEscape() {
    const text = this.text;
    const ch = text[this.i];
    this.i += 1;
    switch (ch) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case 'u': {
        const hex = text.slice(this.i, this.i + 4);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.i += 4;
          return String.fromCharCode(Number.parseInt(hex, 16));
        }
        return 'u';
      }
      case 'x': {
        const hex = text.slice(this.i, this.i + 2);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          this.i += 2;
          return String.fromCharCode(Number.parseInt(hex, 16));
        }
        return 'x';
      }
      case '\n':
        return ''; // 行续接
      case '\r':
        if (text[this.i] === '\n') this.i += 1;
        return '';
      default:
        return ch;
    }
  }

  parseNumber() {
    const match = NUMBER_RE.exec(this.text.slice(this.i, this.i + 64));
    if (!match) return { ok: false };
    this.i += match[0].length;
    return { ok: true, value: Number(match[0]) };
  }

  parseWord() {
    const text = this.text;
    const start = this.i;
    while (this.i < this.len && IDENT_CONT.test(text[this.i])) this.i += 1;
    const word = text.slice(start, this.i);
    if (word === 'true') return { ok: true, value: true };
    if (word === 'false') return { ok: true, value: false };
    if (word === 'null' || word === 'undefined' || word === 'NaN') return { ok: true, value: null };
    if (word === 'Infinity') return { ok: true, value: null };
    // OTCL 容错：裸单词当字符串（例如 command: ls）
    return { ok: true, value: word };
  }
}

function skipTriviaAt(text, index) {
  const reader = new Reader(text, index);
  reader.skipTrivia();
  return reader.i;
}

function readIdentifier(text, index) {
  if (index >= text.length || !IDENT_START.test(text[index])) return null;
  let end = index + 1;
  while (end < text.length && IDENT_CONT.test(text[end])) end += 1;
  return { name: text.slice(index, end), end };
}


/**
 * 找出文本里的 `!OTCL` … `-OTCL` 块。
 * 未闭合的块一直延伸到文本结尾（流式截断 / 输出截断时用）。
 *
 * @returns {{ start: number, bodyStart: number, bodyEnd: number, end: number, closed: boolean }[]}
 */
export function findOtclBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const blocks = [];
  const openRe = /!OTCL/gi;
  const closeRe = /-OTCL/gi;
  let match;
  let from = 0;
  while ((match = openRe.exec(text)) !== null) {
    const start = match.index;
    const bodyStart = start + match[0].length;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(text);
    if (!close) {
      blocks.push({ start, bodyStart, bodyEnd: text.length, end: text.length, closed: false });
      break;
    }
    blocks.push({ start, bodyStart, bodyEnd: close.index, end: close.index + close[0].length, closed: true });
    openRe.lastIndex = close.index + close[0].length;
  }
  return blocks;
}

/**
 * 解析块内的一段文本（块内所有内容都按 OTCL 处理，不做「像不像代码」的判断）。
 * @returns {{ name: string, arguments: string, raw: string, end: number, complete: boolean }[]}
 */
function parseCallsInBody(body) {
  const calls = [];
  let pos = 0;
  while (pos <= body.length) {
    let lineEnd = body.indexOf('\n', pos);
    if (lineEnd === -1) lineEnd = body.length;

    const decor = LINE_DECOR.exec(body.slice(pos, lineEnd));
    let cursor = pos + (decor ? decor[0].length : 0);

    for (let guard = 0; guard < 64; guard += 1) {
      while (cursor < lineEnd && (body[cursor] === ' ' || body[cursor] === '\t')) cursor += 1;
      if (cursor >= lineEnd) break;

      const call = parseCallAt(body, cursor);
      if (!call) break;
      calls.push({ ...call, index: cursor });

      if (!call.complete) return calls; // 截断：后面不会再有完整语句
      cursor = call.end;
      if (cursor > lineEnd) {
        lineEnd = body.indexOf('\n', cursor);
        if (lineEnd === -1) lineEnd = body.length;
        break;
      }
    }

    pos = lineEnd + 1;
    if (lineEnd === body.length) break;
  }
  return calls;
}

/**
 * 解析块里的一个 OTCL 调用（pos 必须指向工具名的第一个字符）。
 * @returns {null | { name: string, arguments: string, raw: string, end: number, complete: boolean }}
 */
function parseCallAt(text, pos) {
  const ident = readIdentifier(text, pos);
  if (!ident) return null;
  const { name } = ident;

  const afterName = skipTriviaAt(text, ident.end);
  if (text[afterName] !== '(') return null;

  let end;
  let args;
  let complete = false;
  const argAt = skipTriviaAt(text, afterName + 1);

  if (text[argAt] === ')') {
    args = {};
    end = argAt + 1;
    complete = true;
  } else if (text[argAt] === '{') {
    const reader = new Reader(text, argAt);
    const parsed = reader.parseObject();
    if (!parsed.ok) return null;
    args = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {};
    end = reader.i;

    const afterValue = skipTriviaAt(text, end);
    if (text[afterValue] === ')') {
      end = afterValue + 1;
      complete = true;
    } else if (afterValue >= text.length) {
      end = text.length;
      complete = false;
    } else {
      return null;
    }
  } else {
    return null;
  }

  if (text[end] === ';') end += 1;
  return { name, args, arguments: JSON.stringify(args), raw: text.slice(pos, end), end, complete };
}

/**
 * 从文本里解析 OTCL 工具调用：只认 `!OTCL` … `-OTCL` 之间的内容。
 *
 * @param {string} text
 * @param {string[]|Set<string>|null} [_knownTools] 兼容旧签名，已不再参与识别
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseOtclCalls(text, _knownTools = null) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];
  for (const block of findOtclBlocks(text)) {
    const body = text.slice(block.bodyStart, block.bodyEnd);
    for (const call of parseCallsInBody(body)) {
      calls.push({
        name: call.name,
        arguments: call.arguments,
        raw: call.raw,
        index: block.bodyStart + call.index,
      });
    }
  }
  return calls;
}

/**
 * 流式过滤：把 `!OTCL` … `-OTCL` 整块从正文里扣掉（块内容只用于最终解析工具调用，
 * 不发给客户端）；块外的普通正文（包括用户要的 JS 代码）照常流出。
 *
 * - 半截的开始标记（`!`、`!OT`、`!OTCL`…）先扣住，等后续 chunk；
 * - 块内内容直接丢弃，只保留可能是半截结束标记的尾巴；
 * - 结束标记出现后回到正文模式；EOF 时块未闭合则整块丢弃。
 */
export class OtclBlockStreamFilter {
  constructor() {
    this.buffer = '';
    this.inBlock = false;
  }

  /** @returns {{ content: string }} */
  push(text) {
    if (text) this.buffer += text;
    let content = '';

    for (;;) {
      if (!this.inBlock) {
        const lower = this.buffer.toLowerCase();
        const at = lower.indexOf('!otcl');
        if (at === -1) {
          const keep = partialMarkerTail(this.buffer, OPEN_PREFIXES);
          content += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          break;
        }
        content += this.buffer.slice(0, at);
        const rest = this.buffer.slice(at);
        const open = BLOCK_OPEN.exec(rest);
        if (!open || open.index !== 0) {
          if (isPartialOpen(rest)) {
            // 标记还没吐完整，先扣住
            this.buffer = rest;
            break;
          }
          // 只是普通文本里恰好出现 "!otcl..."：把 '!' 当正文发出去，继续扫描
          content += rest[0];
          this.buffer = rest.slice(1);
          continue;
        }
        this.buffer = rest.slice(open[0].length);
        this.inBlock = true;
        continue;
      }

      // 块内：找 -OTCL
      const lower = this.buffer.toLowerCase();
      const at = lower.indexOf('-otcl');
      if (at === -1) {
        const keep = partialMarkerTail(this.buffer, CLOSE_PREFIXES);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        break;
      }
      this.buffer = this.buffer.slice(at);
      const close = BLOCK_CLOSE.exec(this.buffer);
      if (!close || close.index !== 0) {
        if (isPartialClose(this.buffer)) break; // 等结束标记吐完
        this.buffer = this.buffer.slice(1); // 不是真标记：丢弃块内这个字符继续找
        continue;
      }
      this.buffer = this.buffer.slice(close[0].length);
      this.inBlock = false;
    }

    return { content };
  }

  /** 收尾：块外剩余内容发出去；块内未闭合内容直接丢掉 */
  finalize() {
    const content = this.inBlock ? '' : this.buffer;
    this.buffer = '';
    this.inBlock = false;
    return { content };
  }
}

const OPEN_PREFIXES = ['!', '!o', '!ot', '!otc', '!otcl'];
const CLOSE_PREFIXES = ['-', '-o', '-ot', '-otc', '-otcl'];

/** 开头是不是 !OTCL 的半截前缀 */
function isPartialOpen(text) {
  return /^!(?:O(?:T(?:C(?:L)?)?)?)?$/i.test(text);
}

/** 开头是不是 -OTCL 的半截前缀 */
function isPartialClose(text) {
  return /^-(?:O(?:T(?:C(?:L)?)?)?)?$/i.test(text);
}

/** buffer 结尾可能是半截标记前缀的长度（0 表示不用扣） */
function partialMarkerTail(buffer, prefixes) {
  for (let len = Math.min(buffer.length, 6); len >= 1; len -= 1) {
    if (prefixes.includes(buffer.slice(-len).toLowerCase())) return len;
  }
  return 0;
}
