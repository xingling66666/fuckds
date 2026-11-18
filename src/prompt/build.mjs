import { ApiError } from '../errors.mjs';
import { contentToText } from '../util.mjs';
import {
  FINAL_ANSWER_HINT,
  PROMPT_HEADER,
  PROMPT_HEADER_STEALTH,
  REPLY_END_TOKEN,
  SECTION,
  SECTION_STEALTH,
  SPECIAL_TOKENS_HEADER,
  SPECIAL_TOKENS_HEADER_CHAT,
  SPECIAL_TOKENS_HEADER_STEALTH,
  TOOL_XML_HINT,
  TOOL_RECORD,
} from './special.mjs';
import { escapeUnsafeMarkup } from './sanitize.mjs';
import { redactSecrets } from './redact.mjs';
import { describeCalls } from './fence.mjs';
import { collectToolNames, renderCompactToolDeclarations, renderToolDeclarations, renderProseToolDeclarations } from './tools.mjs';
import { findToolBlocksAny, parseToolCallsAny, buildToolCallBlock } from './toolformat.mjs';

const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/**
 * 把 OpenAI / Anthropic 的 messages 拼成网页输入框里的一条 prompt。
 *
 * 一次请求 = 一次全新对话，模型没有任何服务端会话状态，所以**上下文全靠这些段落**。
 * 当前形状（promptStyle=legacy；stealth 只是标签换成中性词）：
 *
 *   # Messages:
 *
 *   System
 *   <客户端传入的 system / developer 文本>
 *
 *   # 本次可用工具
 *   {"name":"exec_shell","description":"Exec shell command","parameters":{...}}
 *
 *   System
 *   <自带协议提示词：DSML 工具调用格式（见 special.mjs）>
 *
 *   [User]:
 *   看看内核
 *
 *   [Assistant]:
 *   我先查一下。⟨密文块：这次调用的工具名与参数⟩
 *
 *   [User]:
 *   ​​​​:
 *   Linux ubuntu 6.1
 *   解释一下
 *
 * 三条铁律（历史上都踩过坑，改之前先读一遍）：
 *
 * 1. **assistant 段放模型原文**。客户端回传 assistant 消息时 content 常常是空的，
 *    调用记录在 tool_calls 字段里。这时用**同一套 DSML 块**把调用重建出来，
 *    绝不写 JSON —— 明文 JSON 就是「工具调用」的招牌，写进历史等于主动给风控送特征
 *    （当初改用密文控制字符就是为了这个）。
 *    有原文缓存时（rememberRawText / hydrateAssistantText）优先用原文，重建只是兜底。
 *
 * 1b. **块必须逐字保真**。上下文里的块要和模型当初吐出来的那个块一模一样
 *     （同样的控制字符、同样的参数写法、字符串不加引号），否则模型会把它当成
 *     "另一种格式"重新学习 —— 所以能拿原文就拿原文，重建只在兜底时发生。
 *
 * 2. **工具结果用零宽标记 + 纯文本**。`TOOL_RECORD`（4×U+200B）加一个冒号作前缀，
 *    内容是原样的执行结果文本（不是 JSON），并进 user 段 —— 模型看到的是
 *    "用户把结果贴回来了"，不会把结果当成自己说过的话。
 *
 * 3. **历史里不出现可读标签**。没有 `## OTC` / `## OTCR`：可读标签本身就是"客户端在驱动
 *    工具调用"的特征。整条链路只留两种痕迹：密文块（调用）和零宽标记（结果）。
 */
/**
 * 把工具结果洗成人话。
 *
 * 客户端回传的通常是 {"result":"undefined"} / {"stdout":"..."} / [{"type":"text","text":"..."}]，
 * 原样塞进 prompt 就是"机器在传数据"的铁证。这里尽量取出真正的内容，
 * 取不到就原样返回（但至少不再加冒号和零宽标记）。
 */
export function humanizeToolResult(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '（空）';
  try {
    const parsed = JSON.parse(text);
    const pick = (v) => {
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) {
        const parts = v.map((x) => x?.text ?? x?.content ?? x?.result ?? (typeof x === 'string' ? x : '')).filter(Boolean);
        return parts.length ? parts.join('\n') : JSON.stringify(v);
      }
      if (v && typeof v === 'object') {
        for (const k of ['result', 'content', 'stdout', 'output', 'text', 'data', 'message', 'error']) {
          if (v[k] !== undefined) return pick(v[k]);
        }
        const keys = Object.keys(v);
        if (keys.length === 1 && typeof v[keys[0]] === 'string') return v[keys[0]];
        return JSON.stringify(v);
      }
      return String(v);
    };
    return pick(parsed);
  } catch {
    // 已经是纯文本（或半个 JSON），原样用
    return text;
  }
}

export function buildPrompt({
  messages,
  tools = [],
  systemExtra = '',
  toolDeclMode = 'prose',
  protocolMode: optsProtocolMode = 'nudge',
  /**
   * 续聊模式：只输出「消息段落」，不带协议头 / system / 工具声明。
   *
   * 为什么要这个：真正的人类客户端在同一个会话里只发**新的那条消息**，
   * 上下文由服务端会话保存。我们第一轮已经把 header/system/tools 教给模型了，
   * 后续每轮再带一遍既浪费体积，也让请求体积「看起来」像全量。
   */
  sectionsOnly = false,
  /**
   * 提示词风格：
   *   stealth（默认）中性词（System / [User]: / [Calls]: / [Results]:）—— 不出现 tool/工具 字样
   *   legacy  直白写法（System / # 本次可用工具 / [User]: / ## OTC / ## OTCR）
   * 两种风格教的是同一个输出协议（DSML），只有措辞和标签不同。
   * 实测：prompt 里出现「工具调用 / tool_calls / function」这类字眼更容易被风控盯上。
   */
  // 默认 legacy：buildPrompt 是被到处直接调用的底层函数，默认值不该悄悄改变输出格式。
  // 生产链路由 config.runtime.promptStyle（默认 stealth）显式传进来。
  promptStyle = 'legacy',
}) {
  const stealth = promptStyle !== 'legacy';
  const SECTION_LABELS = stealth ? SECTION_STEALTH : SECTION;
  const HEADER = stealth ? PROMPT_HEADER_STEALTH : PROMPT_HEADER;
  /**
   * 没有声明任何工具时，连调用语法都不教：模型不进入工具模式，
   * 输出里就不会莫名其妙混进块标记（历史上这类标记是最明显的风控特征）。
   */
  const hasTools = Array.isArray(tools) && tools.length > 0;
  // 两种 style 现在**都只教 XML**（DSML 不再出现在任何提示词里，只留在解析器兜底）
  /**
   * 协议模式：
   *   nudge（默认）—— **完全不教格式**。只在用户那句话后面随口补一句「要用就直接给命令」，
   *                    措辞每次随机，避免固定字符串指纹。实测任何"协议段"都会拉高风险。
   *   fence         —— 教「执行 + 代码块」段落（上一版）
   *   legacy        —— 教 XML 段落
   */
  const protocolMode = optsProtocolMode || 'nudge';
  const NUDGES = [
    '\n\n（需要跑命令的话直接把命令写出来就行）',
    '\n\n（有要执行的命令直接给，代码块就行）',
    '\n\n（能直接用命令解决的直接给命令）',
    '\n\n（要用命令就直接写，不用解释）',
    '\n\n（跑命令的话把命令贴出来即可）',
  ];
  const PROTOCOL = stealth
    ? hasTools
      ? SPECIAL_TOKENS_HEADER_STEALTH
      : SPECIAL_TOKENS_HEADER_CHAT
    : hasTools
      ? SPECIAL_TOKENS_HEADER + TOOL_XML_HINT
      : SPECIAL_TOKENS_HEADER;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'messages 不能为空', { code: 'invalid_messages' });
  }

  const systemTexts = [];
  /** @type {{role: 'user'|'assistant', lines: string[]}[]} */
  const sections = [];

  for (const [index, message] of messages.entries()) {
    const role = message?.role;
    if (!VALID_ROLES.has(role)) {
      throw new ApiError(400, `messages[${index}].role 不合法: ${JSON.stringify(role)}`, {
        code: 'invalid_role',
        param: `messages[${index}].role`,
      });
    }

    if (role === 'system' || role === 'developer') {
      const text = escapeUnsafeMarkup(contentToText(message.content, role)).trim();
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'user') {
      const text = escapeUnsafeMarkup(contentToText(message.content, 'user'));
      // 连续两条 user（比如"工具结果 + 追问"）并成一个 User 块，避免出现两个 # User
      const lastUser = sections.at(-1);
      if (lastUser?.role === 'user') lastUser.lines.push('', text);
      else sections.push({ role: 'user', lines: [text] });
      continue;
    }

    if (role === 'assistant') {
      /**
       * 上下文里的 assistant 就是模型自己的原文，格式只有 DSML 一种
       * （历史里带 DSML 块时要原样保留，所以这里不能整段做尖括号转义）。
       */
      const rawText = escapeKeepingToolBlocks(contentToText(message.content, 'assistant'));

      const toolBlocks = findToolBlocksAny(rawText);
      let text = rawText;

      let calls = message.tool_calls ?? message.toolCalls;
      if ((!Array.isArray(calls) || !calls.length) && toolBlocks.length) {
        // 客户端没回传调用时，从 DSML 原文里还原（否则这一段上下文只剩"我查一下"）
        // 传工具名当 allowed：否则裸代码块（```工具名）在历史里解析不出来，
        // 就会原样留在上下文中，把"客户端驱动调用"的痕迹带回去。
        const toolNames = (tools || []).map((t) => (t?.function ?? t)?.name).filter(Boolean);
        const schemaMap = new Map(
          (tools || [])
            .map((t) => [((t?.function ?? t)?.name || '').trim(), (t?.function ?? t)?.parameters])
            .filter(([n]) => n),
        );
        calls = parseToolCallsAny(rawText, toolNames, { toolSchemas: schemaMap }).map((call) => ({
          name: call.name,
          arguments: call.arguments,
        }));
      }

      // 原文里残留的旧标签（<plan> / <____tool____> / DSML）一律清掉：
      // 留着会被模型模仿，等于把旧协议指纹带回去。
      let cleanedText = String(text || '')
        .replace(/<plan>[\s\S]*?<\/plan>/gi, '')
        .replace(/<____tool____>[\s\S]*?<\/____tool____>/gi, '')
        .replace(/<\|?DSML\|?[\s\S]*?<\/\|?DSML\|?>/gi, '')
        .trim();
      // 有调用时：把原文里的代码块全部剔掉，再由 buildToolCallBlock 统一重建一个，
      // 否则同一个调用会出现两次（模型会以为要执行两遍）。
      if (Array.isArray(calls) && calls.length) {
        cleanedText = cleanedText.replace(/```[\s\S]*?```/g, '').trim();
      }
      // 历史里不用代码块记录调用：语言标记写成工具名是"套壳客户端"独有的痕迹。
      // 改成一句人话（模型要不要再调，由 System 里的提示决定）。
      const callBlock = calls.length ? describeCalls(calls) : '';
      const body = [cleanedText, callBlock].filter(Boolean).join('\n');
      sections.push({ role: 'assistant', lines: [body] });
      continue;
    }

    /**
     * tool / function 结果：零宽标记 + 纯文本，并进 user 段。
     *
     * 不新开段落、不写 JSON、不写成 assistant 口吻：模型看到的是"用户把执行结果贴回来了"，
     * 因此不会把结果当成自己说过的话，也不会照着段落标签去模仿工具调用。
     */
    // 把客户端回传的结果变成**人话**：裸 JSON + 冒号是"程序在回传工具结果"的最强特征。
    // 实测 token 就是在这一轮被吊销的，所以这里必须洗成自然语言。
    const content = humanizeToolResult(escapeUnsafeMarkup(contentToText(message.content, role)));
    const block = `刚拿到结果：${content}`;
    const tail = sections.at(-1);
    if (tail?.role === 'user') tail.lines.push('', block);
    else sections.push({ role: 'user', lines: [block] });
  }

  // 顺序：客户端 system → 工具声明 → 自带提示词（单独 system 块）→ 对话历史（user 在最后）
  const extra = escapeUnsafeMarkup(typeof systemExtra === 'string' ? systemExtra.trim() : '');
  const parts = sectionsOnly ? [] : HEADER ? [HEADER, SECTION_LABELS.system] : [SECTION_LABELS.system];
  // nudge 措辞放 System 段：这是"系统给模型的提示"，不是用户说的话。
  // 放用户块会让模型以为是用户的意图，进而把回答写成解释而不是直接给命令。
  const nudgeLine = protocolMode === 'nudge' && hasTools
    ? [
        '需要动手时直接输出一个代码块，不要先解释。',
        '代码块的语言标记写**工具名**，块里只放给它的参数原文；',
        '**不要**把调用写成函数形式（不要出现 工具名(...) 这种写法）。',
      ].join('')
    : '';
  const systemBody = redactSecrets(
    [...systemTexts, extra, nudgeLine].filter(Boolean).join('\n\n'),
  ).text;
  if (!sectionsOnly && systemBody) parts.push(systemBody);

  // full：完整 JSON 声明；compact：一行一个工具（体积约剩 1/10，且永不挪进附件）
  const toolLines = sectionsOnly
    ? []
    : (toolDeclMode === 'full'
        ? renderToolDeclarations(tools)
        : toolDeclMode === 'compact'
          ? renderCompactToolDeclarations(tools)
          : renderProseToolDeclarations(tools)
      ).map(
        (line) => escapeUnsafeMarkup(line),
      );
  if (toolLines.length) {
    if (protocolMode === 'nudge') {
      // 一句话带过：就像用户告诉模型"我这儿有这些命令可以用"
      const items = tools
        .map((t) => {
          const fn = t?.function ?? t;
          const name = String(fn?.name || '').trim();
          if (!name) return '';
          const desc = String(fn?.description || '').replace(/\s+/g, ' ').trim().slice(0, 40);
          return desc ? `${name}（${desc}）` : name;
        })
        .filter(Boolean);
      if (items.length) parts.push('', `我这儿可以直接用：${items.join('、')}。`);
    } else {
      parts.push('', SECTION_LABELS.tools, ...toolLines);
    }
  }

  // 自带的协议提示词：单独一个 system 段，放在工具声明之后、对话历史之前。
  // 协议头可能被清空（去特征实验），空的时候别 push，否则会留下 System 后面一串空行。
  if (!sectionsOnly && protocolMode !== 'nudge' && PROTOCOL.trim()) {
    parts.push('', SECTION_LABELS.system, PROTOCOL.trim());
  }

  const lastIdx = sections.length - 1;
  for (const [si, section] of sections.entries()) {
    // 用户可能把密钥贴进对话：发上游前统一打码（REDACT_SECRETS=0 可关）
    let body = redactSecrets(section.lines.join('\n').trim()).text;
    if (!body) continue;

    // END 结束标记只给模型看：输出给客户端时被过滤掉了，重建上下文时补回 assistant 段末尾
    if (section.role === 'assistant' && !body.includes(REPLY_END_TOKEN)) {
      body = body ? `${body}\n${REPLY_END_TOKEN}` : REPLY_END_TOKEN;
    }
    parts.push('', SECTION_LABELS[section.role], body);
  }

  const prompt = parts.join('\n').trimEnd();

  return {
    prompt,
    systemTexts,
    toolNames: collectToolNames(tools),
    stats: {
      chars: prompt.length,
      sections: sections.length,
      systemMessages: systemTexts.length,
      tools: toolLines.length,
      toolDeclMode,
    },
  };
}

/**
 * 归一 tool_calls：同时吃 OpenAI（{function:{name,arguments}}）与 Anthropic（{name,input}）两种形状。
 * 参数统一解析成对象，供密文块逐项渲染。
 */
function normalizeToolCalls(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    const fn = item?.function ?? item;
    const name = typeof fn?.name === 'string' ? fn.name.trim() : '';
    if (!name) continue;
    let args = fn?.arguments ?? fn?.input ?? {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { input: args };
      }
    }
    out.push({ name, input: args && typeof args === 'object' && !Array.isArray(args) ? args : { input: args } });
  }
  return out;
}

/**
 * 把一次工具调用重建为 **DSML 块**，仅在拿不到模型原文时兜底。
 *
 * 形如：
 *   <｜DSML｜calls>
 *   <｜DSML｜invoke name="exec_shell">
 *   <｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜calls>
 *
 * string="true" 表示原文（原样写，不加引号）；string="false" 表示 JSON 字面量。
 */
function buildDsmlBlock(toolCalls) {
  const calls = normalizeToolCalls(toolCalls);
  if (!calls.length) return '';

  const lines = ['<｜DSML｜calls>'];
  for (const call of calls) {
    lines.push(`<｜DSML｜invoke name="${call.name}">`);
    for (const [key, value] of Object.entries(call.input)) {
      const isText = typeof value === 'string';
      const raw = isText ? value : JSON.stringify(value);
      lines.push(`<｜DSML｜parameter name="${key}" string="${isText ? 'true' : 'false'}">${raw}</｜DSML｜parameter>`);
    }
    lines.push('</｜DSML｜invoke>');
  }
  lines.push('</｜DSML｜calls>');
  return lines.join('\n');
}

/**
 * 转义尖括号，但**放过工具调用块**（XML / DSML）：
 * 这些标签本身带 < >，整段转义会把上下文里的块写成 &lt;…&gt;，
 * 模型看到的就是一堆转义实体，等于没教。
 */
function escapeKeepingToolBlocks(text) {
  const blocks = findToolBlocksAny(text);
  if (!blocks.length) return escapeUnsafeMarkup(text);

  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    if (block.start > cursor) out += escapeUnsafeMarkup(text.slice(cursor, block.start));
    out += text.slice(block.start, block.end);
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < text.length) out += escapeUnsafeMarkup(text.slice(cursor));
  return out;
}

/** 按块区间把文本切成"删掉这些块"的结果（区间已按顺序给出） */
function cutBlocks(text, blocks) {
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    if (block.start > cursor) out += text.slice(cursor, block.start);
    cursor = Math.max(cursor, block.end);
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}
