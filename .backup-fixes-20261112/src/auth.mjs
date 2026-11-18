import fs from 'node:fs';
import path from 'node:path';

/**
 * 把用户粘贴进来的各种形态的 token 统一成纯 token 字符串：
 *   - 裸 token
 *   - "Bearer xxx"
 *   - {"value":"xxx","__version":"0"}   ← localStorage.userToken 的原始值
 *   - 带引号的 JSON 字符串
 */
export function normalizeUserToken(input) {
  if (typeof input !== 'string') throw new Error('token 必须是字符串');
  let value = input.trim();
  if (!value) throw new Error('token 为空');

  if (/^bearer\s+/i.test(value)) value = value.replace(/^bearer\s+/i, '').trim();

  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.value === 'string') value = parsed.value.trim();
    } catch {
      // 不是合法 JSON，就认为用户粘的是裸 token
    }
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  if (value.length < 16) throw new Error(`token 看起来太短了（${value.length} 字符），请检查是否复制完整`);
  if (/\s/.test(value)) throw new Error('token 里不应该有空格或换行');
  return value;
}

export function saveToken(config, token) {
  return saveTokens(config, [token]);
}

/** 号池：保存多个 token（第一个同时写到 token 字段，兼容旧逻辑） */
export function saveTokens(config, tokens) {
  const list = [...new Set(tokens.map((t) => String(t).trim()).filter(Boolean))];
  if (!list.length) throw new Error('没有可保存的 token');
  const payload = { token: list[0], tokens: list, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
  fs.writeFileSync(config.authFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

export function loadTokens(config) {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
    const list = [];
    if (Array.isArray(parsed.tokens)) list.push(...parsed.tokens);
    if (parsed.token) list.push(parsed.token);
    return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function maskToken(token) {
  if (!token) return '(空)';
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}…${token.slice(-6)} (${token.length} 字符)`;
}
