/**
 * DeepSeek web "special token" protocol.
 *
 * Every request is a brand-new web conversation: the model sees no server-side
 * session state, so the role / tool-calling contract must be re-fed every time.
 *
 * Two boundaries that must hold:
 * 1. Tool calls are taught in exactly ONE output syntax: OTCL
 *    (Opends Tool Call Language) — a JavaScript-style call statement such as
 *    `exec_shell({command:"ls"});` that the model emits as plain text. The
 *    server parses it into standard tool_calls / tool_use and strips it from
 *    content / SSE / DOM streaming.
 * 2. Context is NEVER written back as OTCL. Past tool calls are rendered in
 *    history as one JSON line per ## OTC section, and tool results live in
 *    their own ## OTCR section, so the model has no "write the tool syntax /
 *    write the result yourself" template to imitate.
 *
 * Why this file is strict about types (see "Parameter typing" below):
 * the most common tool-call failure in production was NOT a missing call,
 * it was a wrong-typed argument: a number sent as the string "10", an array
 * sent as the string "[\"a\"]", or the whole argument object wrapped in one
 * extra "args" parameter. The prompt therefore states the JavaScript-literal
 * type rules explicitly, and src/prompt/tools.mjs also coerces arguments
 * against the declared schema as a safety net. Prompt and parser must agree;
 * neither alone is enough.
 *
 * Length note: this header is kept short on purpose. It is injected into
 * every request and counts against the prompt character budget (default
 * 100,000, but tests and small MAX_PROMPT_CHARS settings use far less),
 * so every rule here must earn its characters.
 */

export const SPECIAL_TOKENS_HEADER = `

`;

/**
 * 每轮回答的结束标记。
 *
 * 这个 token 专门给模型看：输出给客户端前会被过滤掉（用户看不到），
 * 但拼上下文时要补回 assistant 历史段的末尾，模型才能看到「上一轮回答在哪结束」。
 (暂时没用)
 */
export const REPLY_END_TOKEN = '';

export const SECTION = {
  system: '## System',
  tools: '## Tools',
  user: '## User',
  assistant: '## Assistant',
  /** 历史里已经发生过的工具调用：每行一个 {"name":...,"args":...}*/
  toolCalls: '## OTC',
  toolResult: '## OTCR',
  /** @deprecated 兼容旧名字，等同于 toolResult */
  result: '## OTCR',
};

export const PROMPT_HEADER = '# Messages:\n';
// Last section is a tool result: the model must answer from it, not call
// again. The old value was an empty string, so this hint did nothing and
// the model was left to guess whether another call was expected.
export const FINAL_ANSWER_HINT =
  ``;


/* -------------------------------------------------------------------------- */
/* 去特征版（stealth）：把「工具 / function / tool_call / OTCL」这些字眼全洗掉       */
/* -------------------------------------------------------------------------- */

/**
 * 为什么需要这一版：
 * 线上复盘发现，除了「是不是人」，服务端还会看**你是否在让模型调用外部能力**。
 * prompt 里出现 `Tools` / `工具调用` / `tool_calls` / `function` / `OTCL` 这类字眼时，
 * 被吊销的概率显著上升（多个反代项目都是这么死的）。
 *
 * 这一版把所有相关表述换成中性词，并且**只靠一个例子**教输出格式：
 *   - 「动作」代替「工具调用」
 *   - 「回执」代替「工具结果」
 *   - 围栏用 ```act（不是 ```otcl），解析器两种都认
 *   - 不出现 function / tool / OTCL / OTC / OTCR
 */
export const SPECIAL_TOKENS_HEADER_STEALTH = `

`;

/** 去特征版的段落标记：不用 ## 也不用 "tool" 字样 */
export const SECTION_STEALTH = {
  system: '# System',
  tools:'## Tools',
  user: '# User',
  assistant: '# Assistant',
  toolCalls: '[Tool▁calls]',
  toolResult: '[Tool▁result]',
  result: '[Tool▁result]',
};

export const PROMPT_HEADER_STEALTH = '';


/**
 * 纯聊天版协议（**不教任何工具/动作语法**）。
 *
 * 为什么需要：只要 prompt 里出现"要动手就输出 ```act"这类教学，模型就会进入工具模式，
 * 输出里开始混 `<|DSML|…>` / ```act / ```otcl 等协议标记。
 * 而我们把这类标记当成"客户端在驱动工具调用"的特征——风控同样可能这么看。
 *
 * 所以：客户端**没声明 tools** 时，连动作语法都不要教，纯自然语言对话。
 */
export const SPECIAL_TOKENS_HEADER_CHAT = `

`;
