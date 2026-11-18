/**
 * 敏感信息脱敏 —— 发往上游之前把「用户自己贴进来的密钥」打码。
 *
 * 场景：中转站的用户经常把 `sk-...`、GitHub token、AWS key 直接贴进对话让模型帮忙排查。
 * 这些内容会被完整发给上游，并且（如果命中粘性会话）留在服务端的对话历史里。
 *
 * 默认开启脱敏：宁可让模型看到 `[已屏蔽]`，也不要把别人的凭据送到第三方。
 * 想关掉：REDACT_SECRETS=0
 */

const RULES = [
  // OpenAI / DeepSeek / Moonshot 等 sk- 前缀
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[已屏蔽]'],
  // Anthropic
  [/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'sk-ant-[已屏蔽]'],
  // GitHub
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, 'gh[已屏蔽]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[已屏蔽]'],
  // AWS
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[已屏蔽]'],
  [/\bASIA[0-9A-Z]{16}\b/g, 'ASIA[已屏蔽]'],
  // Slack
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox[已屏蔽]'],
  // Google API key
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, 'AIza[已屏蔽]'],
  // 通用 Bearer
  [/\bBearer\s+[A-Za-z0-9._-]{20,}/g, 'Bearer [已屏蔽]'],
  // 私钥块
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已屏蔽的私钥]'],
  // JWT
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[已屏蔽的 JWT]'],
];

function enabled() {
  return String(process.env.REDACT_SECRETS ?? '1') !== '0';
}

/**
 * 对一段文本脱敏。
 * @param {string} text
 * @returns {{ text: string, hits: number }}
 */
export function redactSecrets(text, { disabled = !enabled() } = {}) {
  const src = String(text ?? '');
  if (disabled || !src) return { text: src, hits: 0 };
  let out = src;
  let hits = 0;
  for (const [re, replacement] of RULES) {
    out = out.replace(re, () => {
      hits += 1;
      return replacement;
    });
  }
  return { text: out, hits };
}

/** 只关心有没有命中（日志用，不落原文） */
export function hasSecret(text) {
  return redactSecrets(text).hits > 0;
}
