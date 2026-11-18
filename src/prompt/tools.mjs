/**
 * 工具声明 / 调用解析。
 *
 * 工具声明（网页 prompt 的 ## Tools 段）有两种渲染模式：
 *   compact（默认推荐）：每行一个工具的完整 JSON —— {"name":...,"description":...,"parameters":...}
 *   full：函数签名 + 缩进参数说明（人话，不是 JSON）
 *
 * 模型输出工具调用只走一种语法：**DSML**（网页版原生的 XML 风格块）：
 *
 *   <｜DSML｜calls><｜DSML｜invoke name="exec_shell">
 *   <｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
 *   </｜DSML｜invoke></｜DSML｜calls>
 *
 * 解析层把它转成标准 tool_calls / tool_use，再从 content / SSE 里剔除；
 * 历史里回写的也是同样形状的 DSML 块（见 build.mjs）。
 *
 * 为了不丢调用，旧格式仍然静默兜底解析（不再对外教学、也不记日志）：
 * - <tool_call> / 原生工具 token / 旧版 DO。
 *
 * 注意：解析只是入口，**回写上下文时一律转成我们的密文块**（见 build.mjs）。
 * 模型输出什么格式都行，它能看到的样例永远只有一种，权重才会往我们的格式上收。
 */

import { parseToolCallsAny } from './toolformat.mjs';

/** 压缩索引里描述保留多少字符 */
const COMPACT_DESC_CHARS = 60;

/**
 * 参数类型的人话描述（full 模式用，**不输出 JSON Schema**）。
 *
 * 类型映射：
 *   string → text          integer → whole number     number → number
 *   boolean → yes/no       array → list of <item>     object → object
 *   enum → a | b | c       （必填参数不带问号）
 */
function describeType(schema) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' | ');
  }
  if (Array.isArray(schema.type)) return schema.type.map((t) => describeType({ ...schema, type: t })).join(' or ');
  switch (schema.type) {
    case 'string':
      return 'text';
    case 'integer':
      return 'whole number';
    case 'number':
      return 'number';
    case 'boolean':
      return 'yes/no';
    case 'array':
      return `list of ${describeType(schema.items)}`;
    case 'object':
      return 'object';
    default:
      return 'any';
  }
}

/** 一行的函数签名：exec_shell(command: text, timeout?: number) */
function renderSignature(name, parameters) {
  const props = parameters?.properties && typeof parameters.properties === 'object' ? parameters.properties : {};
  const required = new Set(Array.isArray(parameters?.required) ? parameters.required : []);
  const parts = Object.entries(props).map(([key, schema]) => {
    const type = describeType(schema);
    return required.has(key) ? `${key}: ${type}` : `${key}?: ${type}`;
  });
  return `${name}(${parts.join(', ')})`;
}

/**
 * 压缩版工具声明：**每行一个工具的完整 JSON**。
 *
 * 输出形状（严格单行，可直接 JSON.parse）：
 *   {"name":"exec_shell","description":"Exec shell command","parameters":{"type":"object","properties":{...}}}
 *
 * 为什么需要紧凑：agent 动辄上百个工具，完整声明能到 100KB，超过网页输入框上限，
 * 以前会被整段挪进附件 —— 模型在正文里看不到工具声明，就会乱调工具
 * （参数结构凭臆测，缺必填字段），最后干脆停摆。每行一个 JSON 既紧凑又结构化。
 *
 * 字段裁剪：
 * - description 压成单行并截断到 COMPACT_DESC_CHARS 字符，避免单行过长；
 * - parameters 原样保留（模型需要完整的 properties / required 才能正确填参）。
 */
export function renderCompactToolDeclarations(tools = []) {
  const lines = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const desc = String(fn.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, COMPACT_DESC_CHARS);
    const record = {
      name: fn.name.trim(),
      description: desc,
      parameters: fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} },
    };
    lines.push(JSON.stringify(record));
  }
  return lines;
}

/**
 * 完整工具声明：一行签名 + 缩进的参数说明（可选）。
 *
 * 复杂工具（嵌套对象、枚举）靠"类型描述"已经够用；这里额外把每个参数自带的
 * description 缩进写出来，给模型选参数时做参考。整块仍然是纯文本，没有 JSON。
 */
export function renderToolDeclarations(tools = []) {
  const lines = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const name = fn.name.trim();
    const desc = String(fn.description ?? '').replace(/\s+/g, ' ').trim();
    lines.push(desc ? `${renderSignature(name, fn.parameters)} — ${desc}` : renderSignature(name, fn.parameters));

    const props = fn.parameters?.properties;
    if (props && typeof props === 'object') {
      for (const [key, schema] of Object.entries(props)) {
        const note = String(schema?.description ?? '').replace(/\s+/g, ' ').trim();
        if (!note) continue;
        lines.push(`  ${key}: ${note}`);
      }
    }
  }
  return lines;
}

/** 从 OpenAI tools 定义里取出「工具名 -> parameters schema」映射（供参数校验/纠正用） */
export function getToolSchemas(tools = []) {
  const map = new Map();
  for (const tool of tools ?? []) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    map.set(fn.name.trim(), fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : null);
  }
  return map;
}

/**
 * `<description>` 默认已经并进 arguments（很多客户端把它声明成必填参数）。
 * 但如果这个工具的声明里**没有** description 参数，就把它裁掉 ——
 * 否则 `additionalProperties: false` 的严格客户端会直接拒绝这次调用。
 */
function trimUnsupportedDescription(call, toolSchemas) {
  if (!toolSchemas || typeof toolSchemas.get !== 'function') return call.arguments;
  const schema = toolSchemas.get(call.name);
  if (!schema || typeof schema !== 'object') return call.arguments;
  const props = schema.properties;
  if (!props || typeof props !== 'object') return call.arguments;
  if (Object.prototype.hasOwnProperty.call(props, 'description')) return call.arguments;

  let args;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return call.arguments;
  }
  if (!args || typeof args !== 'object' || !('description' in args)) return call.arguments;
  delete args.description;
  return JSON.stringify(args);
}

function tryParseJson(text) {
  if (typeof text !== 'string') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function coerceScalar(value, schema, path, warnings) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (!type || value === null || value === undefined) return value;
  if (type === 'integer') {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
    if (typeof value === 'number') return Math.trunc(value);
    warnings.push(`${path}: expected integer, got ${typeof value}`);
    return value;
  }
  if (type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.trim()))) {
      return Number(value.trim());
    }
    warnings.push(`${path}: expected number, got ${typeof value}`);
    return value;
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const lower = value.trim().toLowerCase();
      if (lower === 'true' || lower === '1' || lower === 'yes') return true;
      if (lower === 'false' || lower === '0' || lower === 'no') return false;
    }
    warnings.push(`${path}: expected boolean, got ${typeof value}`);
    return value;
  }
  if (type === 'string') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    warnings.push(`${path}: expected string, got ${typeof value}`);
    return value;
  }
  if (type === 'array') {
    if (Array.isArray(value)) {
      return schema.items ? value.map((item, i) => coerceScalar(item, schema.items, `${path}[${i}]`, warnings)) : value;
    }
    if (typeof value === 'string') {
      const parsed = tryParseJson(value.trim());
      if (parsed.ok && Array.isArray(parsed.value)) {
        return schema.items
          ? parsed.value.map((item, i) => coerceScalar(item, schema.items, `${path}[${i}]`, warnings))
          : parsed.value;
      }
    }
    warnings.push(`${path}: expected array, got ${typeof value}`);
    return value;
  }
  if (type === 'object') {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!schema.properties) return value;
      const out = { ...value };
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in out) out[key] = coerceScalar(out[key], sub, `${path}.${key}`, warnings);
      }
      return out;
    }
    if (typeof value === 'string') {
      const parsed = tryParseJson(value.trim());
      if (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)) {
        return schema.properties ? coerceScalar(parsed.value, schema, path, warnings) : parsed.value;
      }
    }
    warnings.push(`${path}: expected object, got ${typeof value}`);
    return value;
  }
  return value;
}

/**
 * 按工具声明纠正一次工具调用的参数，并返回警告（只含参数名，不含参数值，
 * 避免把可能敏感的参数内容写进日志）。
 *
 * 纠正只做“类型可无歧义还原”的事，绝不编造缺失值：
 * - "10" -> 10（integer）、"true" -> true（boolean）、"[\"a\"]" -> ["a"]（array）
 *   —— 模型在 DSML 里把数字 / 布尔写成字符串时最常见的错法；
 * - 大小写写错的参数名（Query -> query）按声明改名；
 * - 整个参数对象被包进一层 args/arguments/parameters 时拆掉一层；
 * - 必填缺失、枚举不符、无法还原的类型只警告、不改动、不丢弃调用：
 *   丢弃会让客户端收到空回答，改错值比原样返回更糟。
 * 没有声明（工具名不在 tools 里）时原样返回，只字不改。
 *
 * @param {{ name: string, arguments: string }} call
 * @param {Map<string, object|null>} schemas getToolSchemas 的返回值
 * @returns {{ arguments: string, warnings: string[] }}
 */
export function coerceToolCallArguments(call, schemas) {
  const warnings = [];
  if (!call || !schemas?.has?.(call.name)) return { arguments: call?.arguments ?? '{}', warnings };
  let args;
  try {
    args = JSON.parse(call.arguments ?? '{}');
  } catch {
    return { arguments: call.arguments ?? '{}', warnings: [`${call.name}: arguments is not valid JSON`] };
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { arguments: call.arguments, warnings };
  }
  const schema = schemas.get(call.name);
  if (!schema || typeof schema !== 'object') return { arguments: call.arguments, warnings };
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};

  // 单层包装：{args: {...}} / {arguments: {...}} / {parameters: {...}}，且
  // 里层键至少有一个是声明里的参数名 —— 拆掉这层，保留里层。
  const wrapperKeys = ['args', 'arguments', 'parameters'];
  const ownKeys = Object.keys(args);
  if (ownKeys.length === 1 && wrapperKeys.includes(ownKeys[0])) {
    let inner = args[ownKeys[0]];
    if (typeof inner === 'string') {
      const parsed = tryParseJson(inner.trim());
      if (parsed.ok) inner = parsed.value;
    }
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const innerKeys = Object.keys(inner);
      if (innerKeys.some((k) => k in properties)) {
        warnings.push(`${call.name}: unwrapped single "${ownKeys[0]}" wrapper`);
        args = inner;
      }
    }
  }

  // 大小写改名（只在声明里找不到原名、且恰好有一个大小写不敏感的匹配时）
  for (const key of Object.keys(args)) {
    if (key in properties) continue;
    const match = Object.keys(properties).find((p) => p.toLowerCase() === key.toLowerCase());
    if (match) {
      warnings.push(`${call.name}: renamed parameter "${key}" to "${match}"`);
      args[match] = args[key];
      delete args[key];
    } else {
      warnings.push(`${call.name}: unknown parameter "${key}" (kept as-is)`);
    }
  }

  for (const [key, sub] of Object.entries(properties)) {
    if (!(key in args)) continue;
    args[key] = coerceScalar(args[key], sub, `${call.name}.${key}`, warnings);
  }

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!(key in args) || args[key] === undefined) {
        warnings.push(`${call.name}: missing required parameter "${key}" (not invented)`);
      }
    }
  }
  // enum 只警告：服务端替模型“选一个最接近的”是在编造参数。
  for (const [key, sub] of Object.entries(properties)) {
    if (key in args && Array.isArray(sub?.enum) && !sub.enum.includes(args[key])) {
      warnings.push(`${call.name}: parameter "${key}" is not in its enum`);
    }
  }

  return { arguments: JSON.stringify(args), warnings };
}

/** 从文本里读取一个以 `{` 开头的完整 JSON 对象（考虑字符串与转义） */
export function readJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 还没输出完，或者格式坏了
}

/**
 * 旧版 DO 行（`DO:{"name":...}`）的容错解析。
 *
 * 新协议里 prompt / 历史都不再出现 DO（历史调用走 ## FTC 的 JSON 行），
 * 这里保留只是兜底：万一模型/旧客户端还吐 DO，不丢调用、也不报错、不记日志。
 */
const DO_PATTERN = /\bDO\b[ \t*_`~]{0,6}[:：=][ \t*_`~]{0,6}\s*/g;

/** <tool_call>{...}</tool_call>（也认 <tool_calls>；流式截断时缺闭合标签就把后面整段当 body） */
const XML_TOOL_PATTERN = /<tool_calls?\b[^>]*>([\s\S]*?)(?:<\/tool_calls?>|$)/gi;

/** 原生工具 token：`<|tool▁calls▁begin|>`、`<|tool_calls|>`、`<|tool▁sep|>` 之类 */
const NATIVE_TOKEN_SOURCE = '<\\|[^|<>\\r\\n]{0,64}tool[^|<>\\r\\n]{0,64}\\|>';
const NATIVE_TOKEN_PATTERN = new RegExp(NATIVE_TOKEN_SOURCE, 'gi');
const NATIVE_TOKEN_AT = new RegExp(`^(?:${NATIVE_TOKEN_SOURCE})`, 'i');

/** 参数对象键排序后再序列化，方便不同格式的等价调用去重 / 比较 */
export function canonicalArguments(args) {
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    return typeof args === 'string' ? args : JSON.stringify(args ?? {});
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** JSON.parse 的宽松版：修掉裸换行 / 尾随逗号再试一次（模型手写的 JSON 常见） */
function parseJsonLoose(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 继续尝试修复
  }
  try {
    return JSON.parse(repairJsonText(raw));
  } catch {
    return null;
  }
}

/** 转义字符串里的裸控制字符，并去掉对象 / 数组末尾多余的逗号 */
function repairJsonText(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** 读出 `{` 开头的对象并宽松解析；不是对象 / 还没闭合就返回 null */
function readJsonValue(text, start) {
  if (text[start] !== '{') return null;
  const raw = readJsonObject(text, start);
  return raw ? parseJsonLoose(raw) : null;
}

/**
 * 把解析出来的 JSON 归一成 { name, args }。
 * 兼容 OpenAI 风格 `{"function":{"name":...,"arguments":...}}` 包一层的情况。
 */
function normalizeCallObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fn =
    value.function && typeof value.function === 'object' && !Array.isArray(value.function)
      ? value.function
      : value;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return null;
  return { name, args: fn.args ?? fn.arguments ?? value.args ?? value.arguments ?? {} };
}

/** <tool_call> 里的 body：整个 JSON、截断的 JSON、后面跟着解释文字都尽量读出来 */
function parseToolCallBody(body) {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) return null;
  const braceAt = trimmed[0] === '{' ? 0 : trimmed.indexOf('{');
  if (braceAt < 0) return null;
  return normalizeCallObject(readJsonValue(trimmed, braceAt));
}

/** 跳过原生 token / `function` 关键字 / ```json 围栏，落到真正的 JSON 上 */
function skipNativeLead(text, from) {
  let i = from;
  for (let step = 0; step < 16; step += 1) {
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const token = NATIVE_TOKEN_AT.exec(text.slice(i, i + 96));
    if (token) {
      i += token[0].length;
      continue;
    }

    const fence = /^```[a-zA-Z0-9_+-]{0,10}[ \t]*\r?\n?/.exec(text.slice(i, i + 24));
    if (fence) {
      i += fence[0].length;
      continue;
    }

    const keyword = /^(?:function|name)[ \t]*[:：=]?[ \t]*["']?/i.exec(text.slice(i, i + 24));
    if (keyword) {
      i += keyword[0].length;
      continue;
    }
    break;
  }
  return i;
}

/** 原生格式里工具名写在 JSON 前面：`function<|tool▁sep|>get_weather` */
function nativeNameBefore(text, from, to) {
  let window = text.slice(from, to);
  if (!window.trim()) return '';
  // 去掉 JSON 前面的代码围栏（```json\n），否则会把 "json" 当成函数名
  window = window.replace(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?[ \t]*$/, '');
  const match = /([A-Za-z_$][\w$.-]{0,63})[ \t\r\n]*$/.exec(window);
  if (!match) return '';
  const name = match[1];
  if (/^(?:function|name|tool|tools|json|arguments|args)$/i.test(name)) return '';
  return name;
}

/**
 * 原生工具 token 的兜底解析。两种形态都认：
 * 1. token 后面直接跟带 name / arguments 的 JSON；
 * 2. 真·原生格式：`function<|tool▁sep|>工具名` 在前，JSON 只是 arguments。
 */
function parseNativeToolCalls(text, add) {
  NATIVE_TOKEN_PATTERN.lastIndex = 0;
  let token;
  while ((token = NATIVE_TOKEN_PATTERN.exec(text)) !== null) {
    const tokenEnd = token.index + token[0].length;

    // 形态 1：token 后面就是完整 JSON（名字在 JSON 里）
    const jsonAt = skipNativeLead(text, tokenEnd);
    const directRaw = readJsonObject(text, jsonAt);
    const direct = directRaw ? normalizeCallObject(parseJsonLoose(directRaw)) : null;
    if (direct) {
      add(direct.name, normalizeArguments(direct.args), text.slice(token.index, jsonAt + directRaw.length), token.index);
      continue;
    }

    // 形态 2：JSON 只是参数，工具名在 JSON 前面
    const braceAt = text.indexOf('{', tokenEnd);
    if (braceAt < 0 || braceAt - tokenEnd > 600) continue;
    const argsRaw = readJsonObject(text, braceAt);
    if (!argsRaw) continue;
    const argsValue = parseJsonLoose(argsRaw);
    if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) continue;
    const name = nativeNameBefore(text, tokenEnd, braceAt);
    if (!name) continue;
    add(name, normalizeArguments(argsValue), text.slice(token.index, braceAt + argsRaw.length), token.index);
  }
}

/**
 * 解析模型回复中的工具调用。
 *
 * 顺序：DSML（唯一对外语法）→ <tool_call> → 原生 token → 旧版 DO 兜底；
 * 最终按出现位置排序，用 canonicalArguments 去重
 * （同一次调用被模型用两种格式重复写出来时只保留一次）。
 *
 * 工具名不再按声明列表过滤：模型偶尔会调一个没声明过的名字（客户端 system / 历史里出现过），
 * 按名字丢弃等于把整轮输出一起吞掉 —— 客户端只会收到一条空的 assistant 消息并判定
 * 「模型未返回正文或工具调用」。未知名字照实返回，由客户端自己回一条 unknown tool，
 * agent 才能自我纠正、loop 才能继续（这也和 OpenAI 兼容接口的既有行为一致）。
 *
 * knownTools 只传给兜底格式的识别启发式（DSML 靠标签定界，不靠工具名），
 * **不参与**过滤。
 *
 * @param {string} text
 * @param {string[]} [knownTools] 声明过的工具名，仅用于识别启发式与调用方日志
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseToolCalls(text, knownTools = null, { toolSchemas = null } = {}) {
  if (!text || typeof text !== 'string') return [];
  const calls = [];
  const seen = new Set();

  const add = (name, args, raw, index) => {
    if (!name) return;
    const argsJson = normalizeArguments(args);
    const signature = `${name}\u0000${canonicalArguments(argsJson)}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    calls.push({ name, arguments: argsJson, raw, index });
  };

  // 1) 工具调用块：代码块 / XML / DSML（knownTools 决定哪些算合法调用）
  const known = Array.isArray(knownTools) ? knownTools : null;
  for (const call of parseToolCallsAny(text, known, { toolSchemas })) {
    add(call.name, trimUnsupportedDescription(call, toolSchemas), call.raw, call.index);
  }

  // 2) <tool_call>{...}</tool_call>：缺闭合标签时按截断处理
  XML_TOOL_PATTERN.lastIndex = 0;
  let xml;
  while ((xml = XML_TOOL_PATTERN.exec(text)) !== null) {
    const call = parseToolCallBody(xml[1]);
    if (!call) continue;
    add(call.name, call.args, xml[0], xml.index);
  }

  // 3) 原生工具 token（<|tool▁calls▁begin|> 之类）兜底
  parseNativeToolCalls(text, add);

  // 4) 旧版 DO 行：只做静默兜底，不记日志、不回写历史
  DO_PATTERN.lastIndex = 0;
  let match;
  while ((match = DO_PATTERN.exec(text)) !== null) {
    const raw = readJsonObject(text, match.index + match[0].length);
    const call = raw ? normalizeCallObject(parseJsonLoose(raw)) : null;
    if (!call) continue;
    add(call.name, call.args, `DO:${raw}`, match.index);
  }

  return calls.sort((a, b) => a.index - b.index);
}

/**
 * 有些模型在 DSML / 旧格式里会把包装对象原样塞进参数：
 *
 *   {"name":"bash","args":{"description":"...","command":"..."}}
 *   {"name":"bash","args":"{\"description\":...,\"command\":...}"}
 *
 * 上层拿到的应该是真正的参数对象，而不是这层包装。这里只在「键正好是 name + args/arguments」
 * 时才拆，避免误伤本来就有 name / args 字段的工具。
 */
export function unwrapCallArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'name' || key === 'args' || key === 'arguments')) return value;
  if (typeof value.name !== 'string' || !value.name.trim()) return value;
  if (!('args' in value) && !('arguments' in value)) return value;

  let inner = 'args' in value ? value.args : value.arguments;
  if (typeof inner === 'string') {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      inner = JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return value;
  return inner;
}

/**
 * 工具调用的参数统一成 JSON 字符串（给 OpenAI tool_calls.arguments 用）。
 * 兼容字符串 / 对象；被包装成 {name,args} 的会先拆掉（见 unwrapCallArguments）。
 */
export function normalizeArguments(args) {
  if (args === undefined || args === null) return '{}';
  let value = args;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      value = JSON.parse(trimmed);
    } catch {
      // 不是合法 JSON 就包一层，避免下游解析炸掉
      return JSON.stringify({ input: args });
    }
  }
  return JSON.stringify(unwrapCallArguments(value));
}

/** 工具执行结果 -> ## FTCR 段里的一行 JSON */
/** 统计工具名（给调用方做「模型调了没声明的工具」这类日志/诊断用） */
export function collectToolNames(tools = []) {
  return tools
    .map((t) => (t?.function ?? t)?.name)
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim());
}

/**
 * 散文式声明：一行一个「名字 —— 干什么（参数 a, b）」，完全不含 JSON / schema 字样。
 *
 * 为什么不用 JSON：{"name":..,"parameters":{"type":"object","properties":..}}
 * 这种结构一旦出现在对话里，就是"客户端在喂 API schema"的铁证。
 */
export function renderProseToolDeclarations(tools = []) {
  const lines = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    const name = String(fn?.name || '').trim();
    if (!name) continue;
    const desc = String(fn?.description || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const props = fn?.parameters?.properties;
    const required = new Set(Array.isArray(fn?.parameters?.required) ? fn.parameters.required : []);
    const params = props && typeof props === 'object'
      ? Object.entries(props).map(([k, v]) => {
          const t = String(v?.type || '');
          return `${k}${required.has(k) ? '' : '?'}${t ? `:${t}` : ''}`;
        })
      : [];
    lines.push(`${name} —— ${desc || '（无说明）'}${params.length ? `（${params.join(', ')}）` : ''}`);
  }
  return lines;
}
