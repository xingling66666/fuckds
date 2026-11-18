/**
 * 微软账户 OAuth2（设备码流程）—— 用于 IMAP 收验证码。
 *
 * 为什么需要：个人版微软账户（outlook.com / hotmail.com / live.cn）**已经废弃应用密码**，
 * IMAP 基本认证直接被拒（"LOGIN failed"/"basic auth disabled"）。剩下的路只有 OAuth2：
 *   IMAP 用 XOAUTH2 携带 access_token。
 *
 * 设备码流程（RFC 8628）最适合服务器/CLI：
 *   1. POST /devicecode 拿到 user_code + verification_uri
 *   2. 用户在浏览器里输入 user_code 并同意
 *   3. 服务端轮询 /token，拿到 access_token + refresh_token
 *   4. 之后长期用 refresh_token 换 access_token（有效期约 1 小时）
 *
 * 需要用户自己注册一个 Azure 应用（免费）：
 *   - 支持的账户类型选「个人 Microsoft 账户」
 *   - 身份验证 → 允许公共客户端流（"Allow public client flows"）打开
 *   - 不需要配置重定向 URI（设备码不需要）
 */

const DEFAULT_TENANT = 'consumers';

/**
 * 内置公共客户端。
 *
 * 微软现在要求「有目录才能注册应用」，个人账户默认没有目录，所以给两个现成的公共客户端：
 *   thunderbird —— Mozilla Thunderbird 的公共客户端，**带 IMAP/SMTP 授权范围**，首选
 *   office      —— Microsoft Office 的公共客户端，主要面向 Graph，IMAP 范围不一定有，兜底用
 *
 * 想完全用自己的应用就把 preset 设成 custom 并填 client_id（Azure 需先有目录：
 * 加入 M365 开发者计划或注册 Azure 会给你一个）。
 */
export const OAUTH_PRESETS = {
  thunderbird: {
    label: '内置 · Thunderbird（推荐，含 IMAP 范围）',
    clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753',
    tenant: 'consumers',
  },
  office: {
    label: '内置 · Microsoft Office（兜底）',
    clientId: 'd3590ed6-52b3-4102-aeff-aad2292ab01c',
    tenant: 'consumers',
  },
  custom: { label: '自定义（我自己的 Azure 应用）', clientId: '', tenant: 'consumers' },
};

/** 解析出实际要用的 clientId / tenant（预设优先，其次自定义） */
export function resolveOAuthClient({ preset = 'thunderbird', clientId = '', tenant = '' } = {}) {
  const key = OAUTH_PRESETS[preset] ? preset : 'thunderbird';
  const base = OAUTH_PRESETS[key];
  const id = String(clientId || '').trim() || base.clientId;
  return { preset: key, clientId: id, tenant: String(tenant || '').trim() || base.tenant };
}

const DEFAULT_SCOPE = 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access';
const TOKEN_SKEW_MS = 120_000; // 提前 2 分钟续期

const base = (tenant) => `https://login.microsoftonline.com/${encodeURIComponent(tenant || DEFAULT_TENANT)}/oauth2/v2.0`;

async function postForm(url, form) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（网关错误页） */
  }
  if (!res.ok) {
    const raw = json?.error_description || json?.error || `HTTP ${res.status}`;
    const friendly = /AADSTS70000|unauthorized or expired/i.test(String(raw))
      ? '本地的 refresh_token 没有新 scope 的授权（比如从 IMAP 换成 Graph）——请在后台重新点「开始 OAuth 授权」'
      : String(raw);
    const err = new Error(friendly);
    err.code = json?.error || `http_${res.status}`;
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  if (!json) throw new Error('OAuth 响应不是 JSON');
  return json;
}

/**
 * 第一步：申请设备码。
 * @returns {Promise<{deviceCode:string,userCode:string,verificationUri:string,expiresIn:number,interval:number,message:string}>}
 */
export async function startDeviceCode({ clientId, tenant = DEFAULT_TENANT, scope = DEFAULT_SCOPE } = {}) {
  if (!clientId) throw new Error('缺少 OAuth client_id（Azure 应用的应用程序(客户端) ID）');
  const json = await postForm(`${base(tenant)}/devicecode`, { client_id: clientId, scope });
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    verificationUriComplete: json.verification_uri_complete || '',
    expiresIn: Number(json.expires_in) || 900,
    interval: Number(json.interval) || 5,
    message: json.message || '',
  };
}

/**
 * 第二步：轮询换 token。用户在浏览器里完成授权后这里才会成功。
 * @returns {Promise<{pending:boolean, slowDown?:boolean, tokens?:{accessToken:string,refreshToken:string,expiresAt:number}}>}
 */
export async function pollDeviceCode({ clientId, tenant = DEFAULT_TENANT, deviceCode, scope = DEFAULT_SCOPE } = {}) {
  try {
    const json = await postForm(`${base(tenant)}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
      scope,
    });
    return { pending: false, tokens: normalizeTokens(json) };
  } catch (err) {
    if (err.code === 'authorization_pending') return { pending: true };
    if (err.code === 'slow_down') return { pending: true, slowDown: true };
    if (err.code === 'expired_token' || err.code === 'code_expired') {
      throw new Error('设备码已过期，请重新开始授权');
    }
    if (err.code === 'authorization_declined') throw new Error('授权被拒绝');
    throw err;
  }
}

/** 用 refresh_token 换新的 access_token（refresh_token 本身也可能被轮换） */
export async function refreshAccessToken({ clientId, tenant = DEFAULT_TENANT, refreshToken, scope = DEFAULT_SCOPE } = {}) {
  if (!clientId) throw new Error('缺少 OAuth client_id');
  if (!refreshToken) throw new Error('缺少 refresh_token，请先完成一次授权');
  const json = await postForm(`${base(tenant)}/token`, {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
    scope,
  });
  return normalizeTokens(json, refreshToken);
}

function normalizeTokens(json, fallbackRefresh = '') {
  const accessToken = json.access_token;
  if (!accessToken) throw new Error('OAuth 没有返回 access_token');
  return {
    accessToken,
    refreshToken: json.refresh_token || fallbackRefresh,
    expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000,
    scope: json.scope || '',
    tokenType: json.token_type || 'Bearer',
  };
}

/* -------------------------------------------------------------------------- *
 * 进程内 token 缓存（按 clientId + user 维度）
 * -------------------------------------------------------------------------- */

const cache = new Map();
// 缓存 key 必须带 scope：IMAP 和 Graph 是两套 audience，混用会拿到 401
const keyOf = ({ clientId, user, scope }) => `${clientId || ''}::${user || ''}::${scope || ''}`;

/**
 * 拿一个可用的 access_token：缓存未过期就复用，否则用 refresh_token 换。
 * @returns {Promise<string>}
 */
export async function getAccessToken({ clientId, tenant, refreshToken, user, scope, onRefresh } = {}) {
  const key = keyOf({ clientId, user, scope });
  const hit = cache.get(key);
  if (hit && hit.expiresAt - TOKEN_SKEW_MS > Date.now()) return hit.accessToken;

  const tokens = await refreshAccessToken({ clientId, tenant, refreshToken, scope });
  cache.set(key, tokens);
  // refresh_token 被轮换时需要持久化，交给调用方
  if (tokens.refreshToken && tokens.refreshToken !== refreshToken) onRefresh?.(tokens.refreshToken);
  return tokens.accessToken;
}

export function cacheTokens({ clientId, user, tokens }) {
  cache.set(keyOf({ clientId, user }), tokens);
}

export function clearTokenCache({ clientId, user, scope } = {}) {
  if (!clientId && !user) {
    cache.clear();
    return;
  }
  const prefix = `${clientId || ''}::${user || ''}::`;
  for (const key of [...cache.keys()]) {
    if (!key.startsWith(prefix)) continue;
    if (scope && !key.endsWith(`::${scope}`)) continue;
    cache.delete(key);
  }
}

export const OAUTH_DEFAULTS = { tenant: DEFAULT_TENANT, scope: DEFAULT_SCOPE };

/** 解出 token 的关键声明（不验签；不透明票据返回 null） */
export function describeToken(token) {
  const t = String(token || '');
  const parts = t.split('.');
  if (parts.length < 2) {
    return { opaque: true, prefix: t.slice(0, 8), length: t.length };
  }
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { aud: json.aud, scp: json.scp || json.roles, upn: json.upn || json.unique_name, exp: json.exp, anonymous: Boolean(json.aud) && false };
  } catch {
    return { opaque: true, prefix: t.slice(0, 8), length: t.length };
  }
}
