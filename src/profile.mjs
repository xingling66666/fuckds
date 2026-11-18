import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * localStorage 快照解析器。
 *
 * 历史说明：这个模块原来服务「真人档案」导入链路——后台粘 `copy(localStorage)`
 * 的整包 JSON，解析出 device-id / 数美指纹 / HIF 缓存，再在浏览器启动时原样注入。
 * **这条链路已经砍掉**：后台不再提供导入入口，浏览器也不再注入任何档案，
 * 号池只支持直接填 userToken。
 *
 * 现在它只剩注册流程（src/register/vnc-session.mjs）在用：注册成功后把当时页面的
 * localStorage 快照解析一份，拿 deviceId 记进号池并给后台展示摘要。
 * 因此只保留 parse/save/summarize 三个入口，不再有 list / remove / load。
 *
 * 支持的输入形态：
 *   1) 整包：{"userToken":"{\"value\":\"...\"}", "deepseek-device-id:chat":"...", ".thumbcache_xxx":"...", ...}
 *   2) 直接给 userToken 的 JSON：{"value":"<token>","__version":"0"}
 *   3) 纯 token 字符串
 */

/** localStorage 里我们关心的键 */
export const PROFILE_KEYS = {
  userToken: 'userToken',
  deviceId: 'deepseek-device-id:chat',
  userInfo: '__appKit_userInfo',
  lastSession: '__appKit_@deepseek/chat_lastSessionValue',
  tea: '__tea_cache_tokens_20006317',
  hifLeim: 'hif_leim_cached',
  hifDliq: 'hif_dliq_cached',
  smid: 'smidV2',
  settingsJwt: 'settingsJwt',
  featureStore: '__ds_remote_feature_store',
  featureModel: '__ds_remote_feature_store_model',
  featureDid: '__ds_remote_feature_did',
  thinking: 'thinkingEnabled',
  search: 'searchEnabled',
};

/** 数美指纹存在 `.thumbcache_<md5(organization)>` 里，键名不固定，按前缀找 */
const thumbcacheKeyOf = (obj) => Object.keys(obj).find((k) => k.startsWith('.thumbcache_')) || null;

/** 安全 JSON.parse：值是 JSON 字符串时再解一层（localStorage 的常见形态） */
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!/^[[{"\d]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * 从 userToken 里抽出真正的 Bearer。
 * - 旧格式：{"value":"<明文>"} → 明文
 * - settingsJwt 那种 {"value":{"ownerHash","jwt"}} 形态也兼容（jwt 作兜底）
 */
export function extractBearer(userTokenRaw) {
  const parsed = parseMaybeJson(userTokenRaw);
  if (typeof parsed === 'string') return parsed.trim();
  const value = parsed?.value;
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') return String(value.jwt || '').trim();
  return '';
}

/**
 * 解析 `copy(localStorage)` 的结果。
 * @param {string|object} input 整包 JSON / userToken JSON / 纯 token
 * @returns {{
 *   token: string,
 *   deviceId: string,
 *   userId: string|null,
 *   email: string|null,
 *   shumeiSeed: {key: string, value: string}|null,
 *   smidV2: string|null,
 *   hif: {leim: string|null, dliq: string|null},
 *   settingsJwt: {ownerHash: string, jwt: string}|null,
 *   tea: object|null,
 *   thinking: boolean|null,
 *   search: boolean|null,
 *   storage: Record<string,string>,
 *   warnings: string[],
 * }}
 */
export function parseProfile(input) {
  const warnings = [];
  let obj = input;
  if (typeof input === 'string') {
    const text = input.trim();
    if (!text) throw new Error('输入为空');
    // 纯 token（不含 { } 的 base64url 串）
    if (!text.startsWith('{') && !text.startsWith('[')) {
      return {
        token: text,
        deviceId: '',
        userId: null,
        email: null,
        shumeiSeed: null,
        smidV2: null,
        hif: { leim: null, dliq: null },
        settingsJwt: null,
        tea: null,
        thinking: null,
        search: null,
        storage: {},
        warnings: ['只给了 token，没有 localStorage 整包：device/数美/HIF 都拿不到，风控特征会弱很多'],
      };
    }
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw new Error(`不是合法 JSON：${err.message}`);
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('解析结果不是对象');

  // 情况 2：直接贴了 userToken 的 JSON
  const looksLikeUserToken = 'value' in obj && !obj[PROFILE_KEYS.userToken];
  const bag = looksLikeUserToken ? { [PROFILE_KEYS.userToken]: JSON.stringify(obj) } : obj;

  const rawUserToken = bag[PROFILE_KEYS.userToken];
  const token = extractBearer(rawUserToken);
  if (!token) throw new Error('没有找到 userToken.value（请确认复制的是 chat.deepseek.com 的 localStorage）');

  const deviceId = String(parseMaybeJson(bag[PROFILE_KEYS.deviceId]) ?? '') || '';
  if (!deviceId) warnings.push('缺少 deepseek-device-id:chat：设备身份不完整');

  const thumbKey = thumbcacheKeyOf(bag);
  const shumeiSeed = thumbKey ? { key: thumbKey, value: String(bag[thumbKey] || '') } : null;
  if (!shumeiSeed) warnings.push('缺少 .thumbcache_*：数美设备 id 算不出来，shumei_device_id 会是空');

  const smidV2 = bag[PROFILE_KEYS.smid] ? String(bag[PROFILE_KEYS.smid]) : null;
  if (smidV2 == null && shumeiSeed) warnings.push('有 .thumbcache_* 但没有 smidV2：数美指纹可能不完整');

  const hifLeim = parseMaybeJson(bag[PROFILE_KEYS.hifLeim]);
  const hifDliq = parseMaybeJson(bag[PROFILE_KEYS.hifDliq]);
  if (!hifLeim) warnings.push('缺少 hif_leim_cached：首轮要重新领 HIF 证明（稍慢，但可用）');

  const userInfo = parseMaybeJson(bag[PROFILE_KEYS.userInfo]);
  const lastSession = parseMaybeJson(bag[PROFILE_KEYS.lastSession]);
  const settingsJwtRaw = parseMaybeJson(bag[PROFILE_KEYS.settingsJwt]);
  const settingsJwt =
    settingsJwtRaw?.value && typeof settingsJwtRaw.value === 'object'
      ? { ownerHash: String(settingsJwtRaw.value.ownerHash || ''), jwt: String(settingsJwtRaw.value.jwt || '') }
      : null;
  const teaRaw = parseMaybeJson(bag[PROFILE_KEYS.tea]);

  // 只保留字符串值（注入 localStorage 用）
  const storage = {};
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v === 'string') storage[k] = v;
    else if (v != null) storage[k] = JSON.stringify(v);
  }

  return {
    token,
    deviceId,
    userId: userInfo?.value?.id ? String(userInfo.value.id) : null,
    email: null,
    shumeiSeed,
    smidV2,
    hif: {
      leim: typeof hifLeim === 'string' ? hifLeim : null,
      dliq: typeof hifDliq === 'string' ? hifDliq : null,
    },
    settingsJwt,
    tea: teaRaw && typeof teaRaw === 'object' ? teaRaw : null,
    thinking: boolOf(parseMaybeJson(bag[PROFILE_KEYS.thinking])),
    search: boolOf(parseMaybeJson(bag[PROFILE_KEYS.search])),
    storage,
    warnings,
  };
}

function boolOf(parsed) {
  const value = parsed?.value ?? parsed;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(1|true|on|yes)$/i.test(value)) return true;
    if (/^(0|false|off|no)$/i.test(value)) return false;
  }
  return null;
}

/** 档案 → 摘要（后台列表/日志用，别把 token 全打出来） */
export function summarizeProfile(profile) {
  return {
    token: profile.token ? `${profile.token.slice(0, 6)}…${profile.token.slice(-4)} (${profile.token.length})` : null,
    deviceId: profile.deviceId || null,
    userId: profile.userId,
    hasShumei: Boolean(profile.shumeiSeed),
    hasSmid: Boolean(profile.smidV2),
    hif: { leim: Boolean(profile.hif?.leim), dliq: Boolean(profile.hif?.dliq) },
    storageKeys: Object.keys(profile.storage || {}).length,
    warnings: profile.warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* 落盘：data/profiles/<fingerprint>.json（注册流程留档；后台导入入口已删除）      */
/* -------------------------------------------------------------------------- */

const profileDir = (dataDir) => path.join(dataDir, 'profiles');
const fileOf = (dataDir, token) =>
  path.join(profileDir(dataDir), `${crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16)}.json`);

/** 只给注册流程（vnc-session）留档用；浏览器启动时不再读取这些文件做注入 */
export function saveProfile(dataDir, profile) {
  const dir = profileDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileOf(dataDir, profile.token);
  const payload = { savedAt: new Date().toISOString(), ...profile };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
}
