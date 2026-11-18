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
} from './special.mjs';
import { escapeUnsafeMarkup } from './sanitize.mjs';
import { collectToolNames, renderCompactToolDeclarations, renderToolDeclarations, renderToolResult } from './tools.mjs';

const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/**
 * 把 OpenAI messages 拼成网页输入框里的一条 prompt。
 *
 * 输出形状（一次请求 = 一次全新对话，模型只能靠这些段落判断上下文）：
 *
 *   # Messages:
 *   ## System
 *   <调用方传入的 system（客户端 prompt 最上面）>
 *
 *   ## Tools
 *   function exec_shell(pars) {
 *     // Exec shell command
 *     // pars: {"type":"object","properties":{"command":{"type":"string"}}}
 *   }
 *
 *   ## System
 *   <自带的特殊 token 声明 / OTCL 工具调用规范（放中间）>
 *
 *   ## User
 *   你好
 *
 *   ## Assistant
 *   你好！有什么可以帮你？
 *
 *   ## FTC
 *   {"name":"exec_shell","args":{"command":"uname -a"}}
 *
 *   ## FTCR
 *   {"name":"exec_shell","result":"Linux"}
 *
 *   ## User
 *   解释一下
 *
 * 顺序：客户端 system 在最上面，自带协议提示词夹在中间，工具声明和对话历史（user）在后面。
 *
 * 注意两件事：
 * - 模型输出工具调用走 OTCL（见 special.mjs / otcl.mjs），但**历史里绝不回写 OTCL**：
 *   已发生的调用统一渲染成 ## FTC 段的 JSON 行，模型没有可模仿的语法样板；
 * - 工具结果**单独成段**（## FTCR），不塞进 ## Assistant，
 *   模型就不会把「assistant 说调用、然后自己写结果」当成正确的模仿对象。
 */
export function buildPrompt({
  messages,
  tools = [],
  systemExtra = '',
  toolDeclMode = 'full',
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
   *   stealth（默认）中性词 + 【回执】/```act —— 不出现 tool/工具/function/OTCL 字样
   *   legacy  旧的 ## System / ## Tools / ```otcl
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
   * 没有声明任何工具时，连"动作语法"都不教 —— 模型不进入工具模式，
   * 就不会吐 <|DSML|…> / ```act 这类协议标记（这是实测到的风控特征）。
   */
  const hasTools = Array.isArray(tools) && tools.length > 0;
  const PROTOCOL = stealth
    ? hasTools
      ? SPECIAL_TOKENS_HEADER_STEALTH
      : SPECIAL_TOKENS_HEADER_CHAT
    : SPECIAL_TOKENS_HEADER;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'messages 不能为空', { code: 'invalid_messages' });
  }

  const systemTexts = [];
  /** @type {{role: 'user'|'assistant'|'toolCalls'|'toolResult', lines: string[]}[]} */
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
       * 历史里的 assistant **直接用模型输出的原文**，不再把 tool_calls 序列化成一段。
       * 理由：序列化（## OTC / 【已执行】里的 JSON）是给模型看的"调用模板"，
       * 模型会照着模仿，反而更容易吐出协议标记；拼原文最接近真人对话。
       */
      const text = escapeUnsafeMarkup(contentToText(message.content, 'assistant'));
      if (text.trim()) sections.push({ role: 'assistant', lines: [text] });
      else sections.push({ role: 'assistant', lines: [''] });
      continue;
    }

    /**
     * tool / function 结果：包成 <tool_result>…</tool_result>，并**并进 User 段**。
     * 不再单独开 [Tool_result] / ## OTCR 段——模型看到的就是"用户把执行结果贴回来了"。
     */
    const body = escapeUnsafeMarkup(contentToText(message.content, role));
    const block = `<tool_result>\n${body}\n</tool_result>`;
    const last = sections.at(-1);
    if (last?.role === 'user') last.lines.push('', block);
    else sections.push({ role: 'user', lines: [block] });
  }

  const lastSection = sections.at(-1);
  if (lastSection?.role === 'toolResult') {
    // 最后一段是工具结果时，段尾补一句「直接回答」，把话头收回来
    lastSection.lines.push('', FINAL_ANSWER_HINT);
  }

  // 顺序：客户端 system → 工具声明 → 自带提示词（单独 system 块）→ 对话历史（user 在最后）
  const extra = escapeUnsafeMarkup(typeof systemExtra === 'string' ? systemExtra.trim() : '');
  const parts = sectionsOnly ? [] : HEADER ? [HEADER, SECTION_LABELS.system] : [SECTION_LABELS.system];
  const systemBody = [...systemTexts, extra].filter(Boolean).join('\n\n');
  if (!sectionsOnly && systemBody) parts.push(systemBody);

  // full：完整 JSON 声明；compact：一行一个工具（体积约剩 1/10，且永不挪进附件）
  let toolLines = sectionsOnly
    ? []
    : (toolDeclMode === 'compact' ? renderCompactToolDeclarations(tools) : renderToolDeclarations(tools)).map(
        (line) => escapeUnsafeMarkup(line),
      );
  if (stealth) {
    // renderXxx 生成的是 `function name(pars) // {...}`；stealth 版只留 `name(pars) // {...}`
    toolLines = toolLines.map((line) => line.replace(/^function\s+/, ''));
  }
  if (toolLines.length) {
    parts.push('', SECTION_LABELS.tools, ...toolLines);
  }

  // 自带的协议提示词：单独一个 system 块，放在 TOOL_FUNCTIONS 之后、USER 之前
  if (!sectionsOnly) parts.push('', SECTION_LABELS.system, PROTOCOL.trim());

  for (const section of sections) {
    let body = section.lines.join('\n').trim();
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

/** 从历史里最近的 ## FTC 段倒着找工具名（tool 结果没带 name 时兜底） */
function findLastToolName(sections) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].role !== 'toolCalls') continue;
    for (let j = sections[i].lines.length - 1; j >= 0; j -= 1) {
      const line = sections[i].lines[j];
      if (!line.startsWith('{')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.name === 'string') return parsed.name;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 把一次工具调用渲染成历史里给模型看的一行 JSON（绝不写 OTCL / DO）。
 * 形如：{"name":"exec_shell","args":{"command":"uname -a"}}
 */
function renderToolCall(name, args) {
  let parsed = {};
  if (typeof args === 'string') {
    try {
      const value = JSON.parse(args);
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : { input: value };
    } catch {
      parsed = { input: args };
    }
  } else if (args && typeof args === 'object') {
    parsed = args;
  }

  return JSON.stringify({ name, args: parsed });
}
