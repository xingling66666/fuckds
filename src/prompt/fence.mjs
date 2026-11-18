/**
 * 代码块协议（最像真人的工具调用格式）。
 *
 * 提示词约定：要动手时直接输出一个代码块，语言标记 = 工具名，块里放参数原文：
 *
 *   ```bash
 *   ls -la
 *   ```
 *
 * 兼容这些模型实际写法：
 *   ```javascript            → eval_javascript("typeof window")
 *   eval_javascript("...")
 *   ```
 *   ```json                  → {"name":"read_file","arguments":{...}}
 *   {...}
 *   ```
 *   ```sh / ```shell / 无标记 → 映射到 shell 类工具
 */

/** 表达式形式：工具名(参数) */
const CALL_EXPR = /^([A-Za-z_][\w.-]*)\s*\(([\s\S]*)\)\s*;?$/;

/** 带「执行」前缀的块（老提示词留下的兼容） */
const MARK = /(?:^|\n)[ \t]*(?:执行|run|执行如下|运行)[ \t]*[:：]?[ \t]*\n[ \t]*```([^\n`]*)\n([\s\S]*?)```/gi;

const FENCE = /```([A-Za-z0-9_+.-]+)?[ \t]*\n([\s\S]*?)```/g;

/** 参数名兜底优先级：单参数工具通常就是这几个之一 */
const PRIMARY_KEYS = ['command', 'cmd', 'script', 'code', 'content', 'path', 'file', 'query', 'text', 'input', 'url'];

const SHELL_ALIASES = new Set(['sh', 'shell', 'bash', 'zsh', 'console', 'terminal', 'cmd', 'powershell', 'ps1', 'command']);

const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** 去掉一层引号：eval_javascript("typeof window") → typeof window */
function unwrapQuotes(text) {
  const t = String(text || '').trim();
  const m = /^(['"`])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : t;
}

/** 内容是 JSON 对象就直接当参数，否则返回 null（交给主参数兜底） */
function toArguments(raw) {
  const body = String(raw || '').trim();
  if (!body) return '{}';
  if (body.startsWith('{') && body.endsWith('}')) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return body;
    } catch {
      /* 不是合法 JSON */
    }
  }
  return null;
}

/** 把纯文本塞进工具的主参数（command / code / path …） */
function fillSingleArg(name, body, schemas) {
  const schema = schemas?.[name];
  const props = schema?.properties ? Object.keys(schema.properties) : [];
  const shellish = /bash|shell|exec|run|cmd|term/i.test(name);
  const key = props.find((k) => PRIMARY_KEYS.includes(k)) || props[0] || (shellish ? 'command' : 'input');
  return JSON.stringify({ [key]: String(body).trim() });
}

/** 判断一个代码块的「语言标记 + 内容」对应哪个工具 */
function resolveTool(rawLang, body, { byNorm, shellTool, allow }) {
  const lang = String(rawLang || '').trim().toLowerCase();
  // 1) 语言标记就是工具名
  let name = byNorm.get(norm(lang)) || '';
  // 2) 语言是 shell 别名 / 空 → 归给 shell 类工具
  if (!name && (SHELL_ALIASES.has(lang) || !lang)) name = shellTool || '';
  return name;
}

export function parseBareFenceCalls(text, allowed = null, schemas = null) {
  if (!text || typeof text !== 'string') return [];
  const allow = Array.isArray(allowed) ? new Set(allowed) : null;
  if (!allow || !allow.size) return [];

  const byNorm = new Map([...allow].map((n) => [norm(n), n]));
  const shellTool = [...allow].find((n) => /bash|shell|exec|run|cmd|terminal|command/i.test(n)) || null;

  const out = [];
  FENCE.lastIndex = 0;
  let m;
  while ((m = FENCE.exec(text)) !== null) {
    const rawLang = String(m[1] || '').trim();
    const body = String(m[2] || '');

    let name = resolveTool(rawLang, body, { byNorm, shellTool, allow });

    // 3) 表达式形式：工具名(参数) —— 语言标记可能是 javascript/js/python 之类
    if (!name) {
      const expr = CALL_EXPR.exec(body.trim());
      const nm = expr ? byNorm.get(norm(expr[1])) : '';
      if (nm) name = nm;
    }

    // 4) JSON 形式：{"name":"x","arguments":{...}}
    if (!name) {
      const trimmed = body.trim();
      if (trimmed.startsWith('{')) {
        try {
          const obj = JSON.parse(trimmed);
          const nm = byNorm.get(norm(obj?.name));
          if (nm) {
            out.push({
              name: nm,
              arguments: JSON.stringify(obj.arguments ?? obj.args ?? obj.parameters ?? {}),
              raw: m[0].trim(),
              index: m.index,
              description: null,
            });
            continue;
          }
        } catch {
          /* 不是 JSON */
        }
      }
    }

    // 5) 只有一个工具时，任何代码块都归它（agent 场景几乎不会错）
    if (!name && allow.size === 1) name = [...allow][0];
    if (!name) continue;

    // 参数：表达式形式取括号里的内容，否则取整个块
    let argText = body;
    const expr = CALL_EXPR.exec(body.trim());
    if (expr && byNorm.get(norm(expr[1])) === name) argText = expr[2];

    const direct = toArguments(argText);
    out.push({
      name,
      arguments: direct ?? fillSingleArg(name, unwrapQuotes(argText), schemas),
      raw: m[0].trim(),
      index: m.index,
      description: null,
    });
  }
  return out;
}

/** 带「执行」前缀的块（兼容老提示词） */
export function parseFenceCalls(text, allowed = null, schemas = null) {
  if (!text || typeof text !== 'string') return [];
  const allow = Array.isArray(allowed) ? new Set(allowed) : null;
  const out = [];
  MARK.lastIndex = 0;
  let m;
  while ((m = MARK.exec(text)) !== null) {
    const name = String(m[1] || '').trim().toLowerCase().split(/\s+/)[0];
    if (!name) continue;
    if (allow && !allow.has(name)) continue;
    const direct = toArguments(m[2]);
    out.push({
      name,
      arguments: direct ?? fillSingleArg(name, m[2], schemas),
      raw: m[0].trim(),
      index: m.index,
      description: null,
    });
  }
  return out;
}

/** 找出所有代码块（用于从正文里剔除） */
export function findFenceBlocks(text) {
  if (!text || typeof text !== 'string') return [];
  const blocks = [];
  FENCE.lastIndex = 0;
  let m;
  while ((m = FENCE.exec(text)) !== null) blocks.push({ raw: m[0], index: m.index, length: m[0].length });
  return blocks;
}

/** 流式过滤用：结尾是否是半个代码块 */
export function findFenceStart(text) {
  const tail = String(text || '').slice(-40);
  return /(?:^|\n)[ \t]*(?:执|执行|run)[ \t]*[:：]?[ \t]*\n?[ \t]*`{0,3}[^\n`]*$/.test(tail);
}

/** 历史写回：只用代码块，语言标记 = 工具名 */
export function buildFenceBlock(calls = [], schemas = null) {
  const lines = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const name = String(call?.name || '').trim();
    if (!name) continue;
    let body = '';
    try {
      const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {};
      const keys = Object.keys(args);
      if (!keys.length) body = '';
      else if (keys.length === 1 && typeof args[keys[0]] === 'string') body = args[keys[0]];
      else body = JSON.stringify(args, null, 2);
    } catch {
      body = String(call.arguments || '');
    }
    lines.push('```' + name.toLowerCase(), String(body).trim(), '```');
  }
  return lines.join('\n');
}

/**
 * 历史里用「人话」记录一次调用（不再用代码块）。
 *
 * 为什么：代码块的语言标记写成工具名（```eval_javascript）在正常聊天里根本不会出现，
 * 是这个客户端独有的痕迹。历史里改写成一句叙述，流量里就看不出"模型被驱动调工具"。
 * 模型该不该再调，靠 System 里那句 nudge 就够了。
 */
export function describeCalls(calls = []) {
  const lines = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    const name = String(call?.name || '').trim();
    if (!name) continue;
    let args = {};
    try {
      args = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments || {};
    } catch {
      args = {};
    }
    // 只说明"用了什么"，不列参数名：`code=...`、`command=...` 这种写法本身就是机器痕迹
    lines.push(`我用 ${name} 跑了一下`);
  }
  return lines.join('；');
}
