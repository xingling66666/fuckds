import fs from 'node:fs';
import path from 'node:path';

import { importFromAuthFile, openTokenStore } from './token-store.mjs';

/**
 * 把用户粘贴的文本按「换行 / 空格 / 逗号 / 分号」拆成候选 token 列表。
 *
 * 关键点：不能切开 JSON 对象/数组内部。用户常常直接粘 localStorage 里的
 * `{"value":"xxx","__version":"0"}`，里面的逗号不是 token 分隔符；未闭合的
 * JSON（比如只复制了一半）也要原样保留成一个候选，后面交给 normalize 报错。
 *
 * 实现上逐字符扫描，跟踪 {} [] 的嵌套深度以及引号内/转义状态，
 * 只有在深度为 0 且不在引号内时才把分隔符当作切分点。
 *
 * @param {string | string[] | null | undefined} input
 * @returns {string[]} trim 后非空的候选字符串
 */
export function splitTokenCandidates(input) {
  if (Array.isArray(input)) {
    return input.map((item) => String(item ?? '').trim()).filter(Boolean);
  }
  if (input == null) return [];

  const text = String(input);
  const candidates = [];
  let current = '';
  let depth = 0;
  let quote = null;
  let escaped = false;

  const flush = () => {
    const value = current.trim();
    if (value) candidates.push(value);
    current = '';
  };

  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (depth > 0) depth -= 1;
      current += ch;
      continue;
    }
    // 深度 0 且不在引号内，才是真正的 token 分隔符
    if (depth === 0 && /[\s,;]/.test(ch)) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return candidates;
}

/** 残留的 JSON 结构字符：出现即说明没被正确解析，不能存进号池 */
const LEFTOVER_JSON_CHARS = /[{}"']/;

/**
 * 把用户粘贴进来的各种形态的 token 统一成纯 token 字符串：
 *   - 裸 token
 *   - "Bearer xxx"
 *   - {"value":"xxx","__version":"0"}   ← localStorage.userToken 的原始值
 *   - 带引号的 JSON 字符串
 *
 * 以 `{` 开头的输入一律当 localStorage JSON 处理：解析失败或没有字符串
 * value 就抛清晰错误，绝不静默降级成裸 token（否则会把 `"__version":"0"}`
 * 之类的垃圾写进号池）。
 */
export function normalizeUserToken(input) {
  if (typeof input !== 'string') throw new Error('token 必须是字符串');
  let value = input.trim();
  if (!value) throw new Error('token 为空');

  if (/^bearer\s+/i.test(value)) value = value.replace(/^bearer\s+/i, '').trim();

  if (value.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('看起来是 localStorage JSON（以 { 开头），但没有解析出 value 字段：JSON 解析失败');
    }
    if (!parsed || typeof parsed.value !== 'string' || !parsed.value.trim()) {
      throw new Error('看起来是 localStorage JSON（以 { 开头），但没有解析出 value 字段');
    }
    value = parsed.value.trim();
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }

  if (LEFTOVER_JSON_CHARS.test(value)) {
    throw new Error('token 里残留了 JSON 结构字符（{ } " \'），看起来只复制了 JSON 的一部分，请重新复制完整');
  }

  if (value.length < 16) throw new Error(`token 看起来太短了（${value.length} 字符），请检查是否复制完整`);
  if (/\s/.test(value)) throw new Error('token 里不应该有空格或换行');
  return value;
}

export function saveToken(config, token) {
  return saveTokens(config, [token]);
}

/** 号池：保存多个 token（第一个同时写到 token 字段，兼容旧逻辑） */
/** 号池存储：SQLite 为权威来源，auth.json 只做镜像（拷号/回滚用） */
function tokenStoreFor(config) {
  if (!config?.dataDir) return null;
  if (config._tokenStore) return config._tokenStore;
  try {
    const store = openTokenStore({ dataDir: config.dataDir });
    // 库为空 + 有旧 auth.json → 一次性导入，保证老用户升级后号池不丢
    if (store.count() === 0) {
      const imported = importFromAuthFile(store, config.authFile);
      if (imported) config._tokenImported = imported;
    }
    config._tokenStore = store;
    return store;
  } catch {
    return null; // 极端情况下退回 auth.json，不让主流程挂掉
  }
}

/** 写入镜像 auth.json（失败不影响主流程） */
function mirrorAuthFile(config, list, savedAt) {
  try {
    const payload = { token: list[0], tokens: list, savedAt };
    fs.mkdirSync(path.dirname(config.authFile), { recursive: true });
    fs.writeFileSync(config.authFile, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* 镜像失败忽略：DB 才是权威 */
  }
}

/**
 * 保存号池（替换语义）。
 * @param {object} config
 * @param {string[]} tokens
 * @param {{source?:string, deviceId?:string, note?:string}} [meta]
 */
export function saveTokens(config, tokens, meta = {}) {
  const list = [...new Set(tokens.map((t) => String(t).trim()).filter(Boolean))];
  if (!list.length) throw new Error('没有可保存的 token');
  const savedAt = new Date().toISOString();
  const store = tokenStoreFor(config);
  if (store) store.replaceAll(list, meta);
  mirrorAuthFile(config, list, savedAt);
  return { token: list[0], tokens: list, savedAt };
}

/** 追加 token（热更新用，returns 实际新增的） */
export function addTokens(config, tokens, meta = {}) {
  const list = [...new Set(tokens.map((t) => String(t).trim()).filter(Boolean))];
  const store = tokenStoreFor(config);
  const added = [];
  for (const token of list) {
    if (!store) continue;
    if (store.add(token, meta)) added.push(token);
  }
  mirrorAuthFile(config, loadTokens(config), new Date().toISOString());
  return added;
}

export function removeToken(config, token) {
  const store = tokenStoreFor(config);
  const removed = store ? store.remove(token) : false;
  mirrorAuthFile(config, loadTokens(config), new Date().toISOString());
  return removed;
}

export function loadTokens(config, { pool = null } = {}) {
  const store = tokenStoreFor(config);
  if (store) {
    // 默认只用可用号：被吊销的不再进池，避免每次请求先撞一次坏号
    return [
      ...new Set(
        store
          .list(pool)
          .filter((row) => (row.status || 'ok') !== 'revoked')
          .map((row) => String(row.token).trim())
          .filter(Boolean),
      ),
    ];
  }
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

/** 带元数据的号池（后台展示设备 id / 来源用） */
export function loadTokenRecords(config) {
  const store = tokenStoreFor(config);
  if (!store) return loadTokens(config).map((token) => ({ token, deviceId: null, source: null }));
  return store.list().map((row) => ({
    token: row.token,
    deviceId: row.deviceId,
    source: row.source,
    createdAt: row.createdAt,
    pool: row.pool || 'main',
    status: row.status || 'ok',
    revokedAt: row.revokedAt || null,
    revokedReason: row.revokedReason || null,
  }));
}

export function maskToken(token) {
  if (!token) return '(空)';
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}…${token.slice(-6)} (${token.length} 字符)`;
}
