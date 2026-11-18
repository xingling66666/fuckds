import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * token 元数据 & 吊销账本。
 *
 * 为什么需要账本：DeepSeek 吊销 token 是**不可逆的事故**（用户实测：同一个号被吊销两次就废了）。
 * 所以「吊销」绝不能被当成普通错误去重试，必须记账 + 熔断：
 *   - 第 1 次吊销：这枚 token 立刻锁死，不再发任何请求（等人工处理）；
 *   - 第 2 次吊销：判定这个号已经废了，直接告诉用户别再用。
 *
 * 文件：<dataDir>/token-meta.json
 *   { "<sha256(token)[:10]>": { source, deviceId, revokedCount, revokedAt, reasons: [] } }
 */

const fileOf = (dataDir) => path.join(dataDir, 'token-meta.json');

export const tokenKey = (token) => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 10);

function readAll(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(dataDir, data) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(fileOf(dataDir), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* 写不了就算了，别影响主流程 */
  }
}

export function getTokenMeta(dataDir, token) {
  const key = tokenKey(token);
  const all = readAll(dataDir);
  return { key, ...(all[key] || {}) };
}

export function setTokenMeta(dataDir, token, patch) {
  const key = tokenKey(token);
  const all = readAll(dataDir);
  all[key] = { ...(all[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  writeAll(dataDir, all);
  return all[key];
}

/**
 * 记一次「服务端吊销」。
 * @returns {{revokedCount:number, fatal:boolean}}
 */
export function recordRevocation(dataDir, token, reason = '') {
  const key = tokenKey(token);
  const all = readAll(dataDir);
  const prev = all[key] || {};
  const revokedCount = (prev.revokedCount || 0) + 1;
  all[key] = {
    ...prev,
    revokedCount,
    revokedAt: new Date().toISOString(),
    lastReason: reason,
    reasons: [...(prev.reasons || []), { at: new Date().toISOString(), reason }].slice(-5),
    updatedAt: new Date().toISOString(),
  };
  writeAll(dataDir, all);
  return { revokedCount, fatal: revokedCount >= 2 };
}

/** 这一枚 token 是不是已经被吊销过（>=1 就该锁死） */
export function revocationState(dataDir, token) {
  const meta = getTokenMeta(dataDir, token);
  const count = meta.revokedCount || 0;
  return { count, locked: count >= 1, fatal: count >= 2, lastAt: meta.revokedAt || null, reason: meta.lastReason || null };
}


/* -------------------------------------------------------------------------- */
/* 账号级吊销账本（用户实测：同一个号被吊销两次基本等于禁言/废号）                  */
/* -------------------------------------------------------------------------- */

/**
 * 按「账号标识」（邮箱/手机号，或 token 的哈希前缀）记吊销次数。
 *
 * 为什么要单独记：吊销是**账号级**惩罚，换一枚新 token 并不能洗白。
 * 实测两次吊销之后这个号就基本不能用了（后续请求被挑战/禁言）。
 * 所以：
 *   count >= 1 → 该账号进入隔离：再次使用前必须人工确认（不要自动重试）
 *   count >= 2 → 判定已废：任何脚本都不许再拿它登录/注册/跑号池
 */
export function recordAccountRevocation(dataDir, accountKey, reason = '') {
  if (!accountKey) return { count: 0, burned: false };
  const file = path.join(dataDir, 'account-bans.json');
  let all = {};
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    all = {};
  }
  const key = String(accountKey).trim().toLowerCase();
  const prev = all[key] || { count: 0, reasons: [] };
  const count = (prev.count || 0) + 1;
  all[key] = {
    count,
    lastAt: new Date().toISOString(),
    reasons: [...(prev.reasons || []), { at: new Date().toISOString(), reason }].slice(-5),
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* 写不了忽略 */
  }
  return { count, burned: count >= 2, quarantined: count >= 1 };
}

export function accountBanState(dataDir, accountKey) {
  if (!accountKey) return { count: 0, burned: false, quarantined: false };
  const file = path.join(dataDir, 'account-bans.json');
  try {
    const all = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    const item = all[String(accountKey).trim().toLowerCase()];
    const count = item?.count || 0;
    return { count, burned: count >= 2, quarantined: count >= 1, lastAt: item?.lastAt || null };
  } catch {
    return { count: 0, burned: false, quarantined: false };
  }
}
