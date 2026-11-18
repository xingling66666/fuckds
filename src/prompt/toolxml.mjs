/**
 * stealth 协议的工具调用格式（`<____tool____>` XML）——解析 / 剔除 / 重建。
 *
 * 提示词（special.mjs 的 SPECIAL_TOKENS_HEADER_STEALTH）教模型输出的是这一套：
 *
 *   <____tool____>
 *   <call name="bash">
 *   <args>
 *   <command>ls -la</command>
 *   <timeout>10</timeout>
 *   </args>
 *   <description>查看当前目录</description>
 *   </call>
 *   </____tool____>
 *
 * 工具结果：
 *
 *   <____tool____>
 *   <result name="bash">
 *   <stdout>hello.py</stdout>
 *   <stderr></stderr>
 *   <exitcode>0</exitcode>
 *   </result>
 *   </____tool____>
 *
 * 本模块只做「文本 → 调用列表」和「调用列表 → 文本」，不碰网络与状态；
 * 对外接口与 dsml.mjs 保持一致，方便上层按 promptStyle 直接切换。
 */

// 新格式（无 "tool/call" 字样，降低流量指纹）；旧格式仅解析兼容
const ENVELOPE = /<(?:____tool____|plan)>([\s\S]*?)<\/(?:____tool____|plan)>/g;
const ENVELOPE_LEGACY = /<____tool____>([\s\S]*?)<\/____tool____>/g;
const ENVELOPE_OPEN_G = /<(?:____tool____|plan)>/g;
const CALL_BLOCK = /<(?:call|step)\s+([^>]*)>([\s\S]*?)<\/(?:call|step)>/g;
const CALL_OPEN_G = /<(?:call|step)\s+([^>]*)/g;
const ARGS_BLOCK = /<args(?:\s[^>]*)?>([\s\S]*?)<\/args>/;
const SELF_CLOSING_ARGS = /<args\s*\/>/;
const TAG_PAIR_AT = /^<([A-Za-z_][\w.-]*)>([\s\S]*?)<\/\1>/;

const ENV_TOKEN = '<plan>';
const ENV_CLOSE = '</plan>';
const CALL_TOKEN = '<step ';

function readAttr(attrs, key) {
  const re = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i');
  const m = re.exec(attrs || '');
  return m ? m[1] : '';
}

/** 把 <args> 里的 <k>v</k> 转成对象；数字/布尔/JSON 字面量做类型还原 */
function coerceScalar(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return '';
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if (/^[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* 不是合法 JSON，按原文 */
    }
  }
  return raw;
}

/** 解析一个参数块：支持一层嵌套标签，嵌套时保留原文 */
function parseArgs(body) {
  const out = {};
  let count = 0;
  let description = null;
  let rest = String(body || '');
  // 逐个吃掉开头的 <k>...</k>
  for (;;) {
    const trimmed = rest.replace(/^\s+/, '');
    const m = TAG_PAIR_AT.exec(trimmed);
    if (!m) break;
    const [, key, value] = m;
    if (key === 'description') {
      // <description> 既是「本次调用说明」，也可能是工具声明里的必填参数：
      // 先单独记下来，是否并进 arguments 由调用方按 schema 决定。
      description = value.trim();
      rest = trimmed.slice(m[0].length);
      continue;
    }
    out[key] = /<[A-Za-z_][\w.-]*>/.test(value) ? value.trim() : coerceScalar(value);
    count += 1;
    rest = trimmed.slice(m[0].length);
  }
  return { args: out, count, description };
}

/**
 * 从文本里解析工具调用。
 *
 * 与 dsml 一样：**不按已知工具名过滤**（丢掉未知调用会让整轮变空，交给客户端报 unknown tool）。
 *
 * @param {string} text
 * @param {Set<string>|null} allowed 保留参数（历史上用于过滤，现已忽略）
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseToolXmlCalls(text, allowed = null, { includeDescription = true } = {}) {
  if (!text || typeof text !== 'string') return [];

  const scopes = [];
  ENVELOPE.lastIndex = 0;
  let env;
  while ((env = ENVELOPE.exec(text)) !== null) {
    scopes.push({ body: env[1], index: env.index });
  }
  // 没有信封（模型直接吐 <call>）时退回全文扫描
  if (!scopes.length) scopes.push({ body: text, index: 0 });

  const calls = [];
  const seen = new Set();
  const push = (name, argsJson, raw, position, description = null) => {
    if (!name) return;
    const signature = `${name}\u0000${argsJson}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    calls.push({ name, arguments: argsJson, raw, index: position, description });
  };

  for (const scope of scopes) {
    const ranges = [];
    CALL_BLOCK.lastIndex = 0;
    let call;
    while ((call = CALL_BLOCK.exec(scope.body)) !== null) {
      ranges.push({ start: call.index, end: call.index + call[0].length });
      const name = (readAttr(call[1], 'name') || '').trim();
      const argBody = ARGS_BLOCK.exec(call[2]);
      const parsed = argBody ? parseArgs(argBody[1]) : { args: {}, count: 0, description: null };
      const args = parsed.count ? parsed.args : {};
      // <description> 落进 arguments：很多客户端把它声明成必填参数，
      // 丢掉就会报 “missing required property description”。
      let description = parsed.description;
      if (description === null) {
        const descMatch = /<description>([\s\S]*?)<\/description>/.exec(call[2] || '');
        if (descMatch) description = descMatch[1].trim();
      }
      if (includeDescription && description !== null && !('description' in args)) {
        args.description = description;
      }
      push(name, JSON.stringify(args), call[0], scope.index + call.index, description);
    }

    // 输出被截断 / 少了 </call>：只认开标签 + 完整参数
    CALL_OPEN_G.lastIndex = 0;
    let open;
    while ((open = CALL_OPEN_G.exec(scope.body)) !== null) {
      if (ranges.some((r) => r.start <= open.index && open.index < r.end)) continue;
      const attrStart = open.index + open[0].length;
      const head = scope.body.slice(attrStart, scope.body.indexOf('>', attrStart) + 1 || attrStart);
      const name = (readAttr(open[1], 'name') || '').trim();
      if (!name) continue;
      const tail = scope.body.slice(attrStart);
      const argBody = ARGS_BLOCK.exec(tail);
      if (!argBody) continue;
      const parsed = parseArgs(argBody[1]);
      if (!parsed.count) continue;
      const args = { ...parsed.args };
      if (includeDescription && parsed.description !== null && !('description' in args)) {
        args.description = parsed.description;
      }
      push(name, JSON.stringify(args), scope.body.slice(open.index, attrStart + argBody.index + argBody[0].length), scope.index + open.index, parsed.description);
    }
  }

  return calls;
}

/**
 * 找出文本里的 XML 工具片段（用于从 content 里剔除）。
 * 未闭合的信封会一直吞到结尾：流式截断 / 只吐了半个调用时，剩下的本来就属于协议。
 */
export function findToolXmlBlocks(text) {
  if (!text) return [];
  const blocks = [];
  const covered = (i) => blocks.some((b) => b.start <= i && i < b.end);

  ENVELOPE.lastIndex = 0;
  let m;
  while ((m = ENVELOPE.exec(text)) !== null) {
    blocks.push({ start: m.index, end: m.index + m[0].length });
  }

  // 未闭合的信封
  ENVELOPE_OPEN_G.lastIndex = 0;
  while ((m = ENVELOPE_OPEN_G.exec(text)) !== null) {
    if (covered(m.index)) continue;
    blocks.push({ start: m.index, end: text.length });
  }

  CALL_BLOCK.lastIndex = 0;
  while ((m = CALL_BLOCK.exec(text)) !== null) {
    if (covered(m.index)) continue;
    blocks.push({ start: m.index, end: m.index + m[0].length });
  }

  CALL_OPEN_G.lastIndex = 0;
  while ((m = CALL_OPEN_G.exec(text)) !== null) {
    if (covered(m.index)) continue;
    blocks.push({ start: m.index, end: text.length });
  }

  return blocks.sort((a, b) => a.start - b.start);
}

function looksLikePrefix(tail) {
  // tail 以 '<' 开头
  if (ENV_TOKEN.startsWith(tail) || tail.startsWith(ENV_TOKEN)) return true;
  if (CALL_TOKEN.startsWith(tail) || tail.startsWith(CALL_TOKEN)) return true;
  if (ENV_CLOSE.startsWith(tail) || tail.startsWith(ENV_CLOSE)) return true;
  return false;
}

function isCompleteOpen(tail) {
  return tail.startsWith(ENV_TOKEN) || tail.startsWith(CALL_TOKEN) || tail.startsWith(ENV_CLOSE);
}

/**
 * 找到第一个 XML 工具标签起点（complete=false 表示还只吐了一半）。
 * 流式过滤器用它提前截断，避免标签漏进 content。
 * @returns {{ index: number, complete: boolean } | null}
 */
export function findToolXmlStart(text, from = 0) {
  if (!text) return null;
  let index = text.indexOf('<', Math.max(0, from));
  while (index !== -1) {
    const tail = text.slice(index);
    if (looksLikePrefix(tail)) {
      return { index, complete: isCompleteOpen(tail) };
    }
    index = text.indexOf('<', index + 1);
  }
  return null;
}

/** 把参数值渲染成标签内容：字符串原样，其它 JSON 化 */
function renderValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

/**
 * 重建调用块（上下文回写用）：客户端只回传 tool_calls 时，用同样形状写回历史。
 * @param {{name:string, input?:object, arguments?:string}[]} toolCalls
 */
export function buildToolXmlBlock(toolCalls) {
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  if (!calls.length) return '';

  const lines = [ENV_TOKEN];
  for (const call of calls) {
    const name = call.name || call.function?.name || '';
    if (!name) continue;
    let input = call.input ?? call.arguments ?? call.function?.arguments ?? {};
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        input = {};
      }
    }
    lines.push(`<step name="${name}">`);
    lines.push('<args>');
    for (const [key, value] of Object.entries(input || {})) {
      lines.push(`<${key}>${renderValue(value)}</${key}>`);
    }
    lines.push('</args>');
    if (call.description) lines.push(`<description>${call.description}</description>`);
    lines.push('</step>');
  }
  lines.push(ENV_CLOSE);
  return lines.join('\n');
}

/**
 * 工具结果块（可选写法）。
 *
 * 默认**不用**它：历史上把结果写成可读标签会持续给风控送「客户端在驱动工具」的特征，
 * 现行做法是零宽标记 + 纯文本。要试新写法时设 TOOL_RESULT_FORMAT=xml。
 */
export function buildToolXmlResultBlock(name, stdout) {
  const lines = [ENV_TOKEN, `<result name="${name || ''}">`];
  lines.push(`<stdout>${String(stdout ?? '')}</stdout>`);
  lines.push('</result>', ENV_CLOSE);
  return lines.join('\n');
}

export const TOOL_XML_TOKENS = { ENV_TOKEN, ENV_CLOSE, CALL_TOKEN };
