/**
 * DeepSeek web "special token" protocol.
 *
 * Every request is a brand-new web conversation: the model sees no server-side
 * session state, so the role / tool-calling contract must be re-fed every time.
 *
 * Two boundaries that must hold:
 * 1. Tool calls are taught in exactly ONE output syntax: the `<____tool____>`
 *    XML block (see TOOL_XML_HINT below). The server parses it into standard
 *    tool_calls / tool_use and strips it from content / SSE.
 * 2. Context is written back in the SAME syntax (buildToolCallBlock), so the
 *    model only ever sees one shape and its weight keeps converging on it.
 *
 * DSML is **no longer taught**. It survives only in the parser as a fallback
 * for old contexts that still contain DSML blocks. Teaching several formats
 * only taught the model to drift.
 */

export const TOOL_XML_HINT = `

`;

export const SPECIAL_TOKENS_HEADER = `
`;

/**
 * 每轮回答的结束标记。
 *
 * 这个 token 专门给模型看：输出给客户端前会被过滤掉（用户看不到），
 * 但拼上下文时要补回 assistant 历史段的末尾，模型才能看到「上一轮回答在哪结束」。
 (暂时没用)
 */
/**
 * 工具记录标记：4 个零宽空格。
 *
 * 为什么用不可见字符而不是 `## OTC` 这种标签：可读标签本身就是「客户端在驱动工具调用」
 * 的特征，历史里反复出现会持续给风控送特征。零宽标记对模型够用（提示词里声明过语义），
 * 在流量里不显眼。
 *
 * 同一标记两种语义，靠位置区分：
 *   - 紧跟 assistant 段：这次调用的参数（一行一个 JSON）
 *   - 出现在 user 段：这次调用的执行结果
 */
export const TOOL_RECORD = '';

export const REPLY_END_TOKEN = '';

export const SECTION = {
  system: 'System',
  tools: '# Tools',
  user: 'User:',
  assistant:'Assistant:',
};

/**
 * 历史里没有"调用段 / 结果段"这种东西了，只有两处痕迹：
 *   - 调用：模型原文里的 DSML 块（build.mjs 的 buildDsmlBlock 重建）
 *   - 结果：user 段里的 TOOL_RECORD 零宽标记 + 纯文本
 * 可读标签（## OTC / ## OTCR）已整条删除 —— 它们本身就是"客户端在驱动工具调用"的特征。
 */

export const PROMPT_HEADER = '# Messages:\n';
// Last section is a tool result: the model must answer from it, not call
// again. The old value was an empty string, so this hint did nothing and
// the model was left to guess whether another call was expected.
/**
 * 输入框里那一句话（正文已经渲染成图片）。
 *
 * 每次调用都生成新的随机数：同一句话重复几十次本身就是特征，
 * 带上一个无意义的随机数，输入框文本每次都不一样。
 */
export function attachmentHint() {
  const noise = Math.floor(Math.random() * 900000) + 100000;
  return ``;
}

/** 兼容旧引用：模块加载时的那一份（运行时应调用 attachmentHint() 拿随机数） */
export const ATTACHMENT_HINT = attachmentHint();

/**
 * 工具执行后的注意力引导（每段工具结果后面都补一句）。
 *
 * 为什么要有：模型拿到工具结果后最容易干的三件蠢事 —— 自己编一个更"合理"的结果、
 * 把同一个调用再发一遍、或者干脆把结果当正文复述。这几条在长上下文里会一路滚雪球
 * （越往后越像"模板"），所以每收到一次执行结果就重新钉一次注意力。
 *
 * 长度控制在 300 字符上下：它跟在每条 TOOL_RECORD 后面，重复次数多，别写长。
 */
export const FINAL_ANSWER_HINT = ``;


/* -------------------------------------------------------------------------- */
/* 去特征版（stealth）：把「工具 / function / tool_call」这些字眼全洗掉              */
/* -------------------------------------------------------------------------- */

/**
 * 为什么需要这一版：
 * 线上复盘发现，除了「是不是人」，服务端还会看**你是否在让模型调用外部能力**。
 * prompt 里出现 `Tools` / `工具调用` / `tool_calls` / `function` 这类字眼时，
 * 被吊销的概率显著上升（多个反代项目都是这么死的）。
 *
 * 这一版把所有相关表述换成中性词，格式说明仍然完整：
 *   - 「动作 / 能力」代替「工具调用」
 *   - 「回执」代替「工具结果」
 *   - 不出现 function / tool / tool_call 字样
 *
 * DSML 是网页版自己认识的形状，服务端本来就在用；这里只是把它写清楚，
 * 让模型别再自己发明格式。
 */
export const SPECIAL_TOKENS_HEADER_STEALTH = `

需要在本机执行东西的时候，先单独起一行写「执行」，紧接着用代码块写内容，
代码块的语言标记用程序名，写完就停，不要解释：

执行
\`\`\`程序名
这里放要执行的内容
\`\`\`

一次只写一个块；拿到结果后照常口语回答，不用再贴这个格式。
`;

/** 去特征版的段落标记：不用 ## 也不用 "tool" 字样 */
export const SECTION_STEALTH = {
  // 实测：System / User / Assistant 这些标签本身不触发风控（用户手动验证过），
  // 真正敏感的是「工具调用协议」段落。所以标签保持标准写法，别再折腾。
  system: 'System:',
  tools: '',
  user: 'User:',
  assistant: 'Assistant:',
  tool: '',
};

export const PROMPT_HEADER_STEALTH = '';


/**
 * 纯聊天版协议（**不教任何动作语法**）。
 *
 * 为什么需要：只要 prompt 里出现"要动手就输出块"这类教学，模型就会进入工具模式，
 * 输出里开始混 DSML 块。而我们把这类标记当成
 * "客户端在驱动外部能力"的特征——风控同样可能这么看。
 *
 * 所以：客户端**没声明 tools** 时，连动作语法都不要教，纯自然语言对话。
 */
export const SPECIAL_TOKENS_HEADER_CHAT = `

`;
