/**
 * 发给网页版模型前的「可疑标记」转义。
 *
 * 背景：网页版前面的 WAF / 风控会把 prompt 里长得像 XML 工具调用语法的东西
 * （`<tool_call>`、`<function_call>`、DeepSeek 原生特殊 token `<｜begin▁of▁sentence｜>`）
 * 当成异常/恶意流量处理，导致整个请求被拦。
 *
 * 这里只处理**由客户端传入的动态内容**（messages / tool 结果 / system 文本），
 * 不处理本服务自己生成的协议段（SPECIAL_TOKENS_HEADER、## 段名、工具声明结构），
 * 否则连 `<think>` 这类模型协议都会被转义掉，工具调用直接失效。
 *
 * 策略是「转义」而不是「删除」：`<` → `&lt;`、`>` → `&gt;`，模型仍能看懂原意，
 * 但请求里不再出现原始尖括号标记。
 */

const escapeAngles = (text) => text.replace(/[<>]/g, (ch) => (ch === '<' ? '&lt;' : '&gt;'));

/** DeepSeek 原生特殊 token：ASCII 竖线 `<|...|>` 或全角竖线 `<｜...｜>` */
const NATIVE_TOKEN = /<[|｜][^<>\n]{0,120}?[|｜]>/g;

/**
 * XML 风格标签：`<tool>`、`</tool_call>`、`<function_call name="x">`、
 * `<antml:invoke>` 等。只匹配「< + 字母开头 + 可选属性 + >」，普通数学比较
 * `a < b`、URL `<https://x>` 不会被误伤。
 */
const XML_TAG = /<\/?[a-zA-Z][\w:.-]{0,48}(?:\s[^<>]{0,300})?\/?>/g;

/**
 * 把一段动态文本里「像工具调用语法」的尖括号标记转义掉。
 *
 * @param {unknown} text
 * @returns {string} 转义后的文本（非字符串原样返回空串语义：非字符串返回 ''）
 */
export function escapeUnsafeMarkup(text) {
  if (typeof text !== 'string' || !text.includes('<')) return typeof text === 'string' ? text : '';
  return text.replace(NATIVE_TOKEN, escapeAngles).replace(XML_TAG, escapeAngles);
}

/**
 * 是否含有会被转义的标记（测试/日志用）。
 * @param {string} text
 */
export function hasUnsafeMarkup(text) {
  if (typeof text !== 'string' || !text.includes('<')) return false;
  NATIVE_TOKEN.lastIndex = 0;
  XML_TAG.lastIndex = 0;
  return NATIVE_TOKEN.test(text) || XML_TAG.test(text);
}
