#!/usr/bin/env node
/**
 * 抓包对账：把「真人浏览器」的请求 和 「我们工具」的请求逐项 diff。
 *
 * 用法：
 *   npm run diff:capture -- --har ~/capture.har
 *   npm run diff:capture -- --har ~/capture.har --url-filter /api/v0/chat/completion
 *
 * 抓包方法（Chrome）：
 *   1. F12 → Network → 勾选 Preserve log
 *   2. 过滤框输入 `completion`（或 `api/v0/chat`）
 *   3. 真人在页面上发一条消息（建议带一次工具调用）
 *   4. 右键请求列表 → Save all as HAR with content
 *
 * 输出四张表：
 *   ① 只在真人侧出现的请求头（我们缺 → 会被静默打分）
 *   ② 只在我们侧出现的请求头（多发 → 也是特征）
 *   ③ 两边都有但值不同（UA / sec-ch-ua / 版本 / 时区 …）
 *   ④ 请求体字段差异（含 shumei_device_id 之类的关键字段）
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { loadTokens } from '../src/auth.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};

const harPath = flag('har');
const urlFilter = flag('url-filter', '/api/v0/chat/completion');
if (!harPath) {
  console.error('用法：npm run diff:capture -- --har <capture.har> [--url-filter /api/v0/chat/completion]');
  process.exit(1);
}

/** 从 HAR 里挑出目标请求 */
function pickRequests(har) {
  const entries = har?.log?.entries ?? [];
  const picked = [];
  for (const entry of entries) {
    const url = entry?.request?.url || '';
    if (!url.includes(urlFilter)) continue;
    const headers = {};
    for (const h of entry.request.headers || []) headers[h.name.toLowerCase()] = h.value;
    let bodyJson = null;
    const post = entry.request.postData;
    if (post?.text) {
      try {
        bodyJson = JSON.parse(post.text);
      } catch {
        bodyJson = null;
      }
    }
    picked.push({
      url,
      method: entry.request.method,
      headers,
      cookies: (entry.request.cookies || []).map((c) => c.name),
      bodyKeys: bodyJson ? Object.keys(bodyJson) : [],
      body: bodyJson,
    });
  }
  return picked;
}

/**
 * 我们这边会发的头（和 src/browser/net.mjs 的 ensureHeaders/附加头保持一致）。
 * 值部分只用于展示，不参与「是否存在」的判断。
 */
function ourExpectedHeaders(config) {
  const token = loadTokens(config)[0] || '';
  return {
    'content-type': 'application/json',
    authorization: token ? `Bearer ${token.slice(0, 8)}…` : '(无 token)',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': config.deepseek?.clientVersion || '2.7.1',
    'x-client-locale': config.deepseek?.locale || 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-device-id': '(来自 localStorage)',
    'x-device-model': '""',
    'x-ds-pow-response': '(每轮新解)',
    'x-hif-leim': '(HIF 证明)',
  };
}

const OUR_BODY_KEYS = [
  'chat_session_id',
  'parent_message_id',
  'model_type',
  'prompt',
  'ref_file_ids',
  'thinking_enabled',
  'search_enabled',
  'action',
  'preempt',
  'shumei_device_id',
];

/** 浏览器自己加的头：不该出现在「我们缺」的清单里，但值得知道 */
const BROWSER_ONLY = new Set([
  'accept-encoding',
  'cookie',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'accept-language',
  'priority',
  'origin',
  'referer',
  'host',
  'content-length',
  'user-agent',
  'accept',
  'connection',
]);

const config = loadConfig({}, { store: false });
const har = JSON.parse(fs.readFileSync(path.resolve(harPath), 'utf8'));
const realRequests = pickRequests(har);

if (!realRequests.length) {
  console.error(`HAR 里没有匹配 ${urlFilter} 的请求。换 --url-filter 试试（比如 /api/v0/chat/）。`);
  process.exit(1);
}

const real = realRequests[0];
const ours = ourExpectedHeaders(config);
const realHeaderNames = new Set(Object.keys(real.headers));
const ourHeaderNames = new Set(Object.keys(ours));

const missingInOurs = [...realHeaderNames].filter((h) => !ourHeaderNames.has(h) && !BROWSER_ONLY.has(h));
const extraInOurs = [...ourHeaderNames].filter((h) => !realHeaderNames.has(h));
const valueDiff = [];
for (const name of [...ourHeaderNames].filter((h) => realHeaderNames.has(h))) {
  const a = String(real.headers[name] ?? '');
  const b = String(ours[name] ?? '');
  if (a !== b && !/\(/.test(b) && name !== 'authorization') valueDiff.push({ name, real: a, ours: b });
}

const missingBodyKeys = OUR_BODY_KEYS.filter((k) => !real.bodyKeys.includes(k));
const realOnlyBodyKeys = real.bodyKeys.filter((k) => !OUR_BODY_KEYS.includes(k));

const line = (s) => console.log(s);
line('');
line(`真人请求：${real.method} ${real.url}`);
line(`真人有 ${realHeaderNames.size} 个头 / cookie ${real.cookies.length} 个 / body 字段 ${real.bodyKeys.length} 个`);
line('');

line('① 真人发了、我们没有的头（会被静默打分）：');
if (!missingInOurs.length) line('   ✅ 无');
else for (const h of missingInOurs) line(`   ❌ ${h}: ${String(real.headers[h]).slice(0, 80)}`);

line('');
line('② 我们发了、真人没有的头（多发也是特征）：');
if (!extraInOurs.length) line('   ✅ 无');
else for (const h of extraInOurs) line(`   ⚠ ${h}: ${String(ours[h]).slice(0, 60)}`);

line('');
line('③ 两边都有但值不同：');
if (!valueDiff.length) line('   ✅ 无显著差异');
else for (const d of valueDiff) line(`   ≠ ${d.name}\n       真人: ${d.real.slice(0, 90)}\n       我们: ${d.ours.slice(0, 90)}`);

line('');
line('④ body 字段：');
line(`   真人字段: ${real.bodyKeys.join(', ')}`);
if (!missingBodyKeys.length) line('   ✅ 我们没有缺字段');
else for (const k of missingBodyKeys) line(`   ❌ 缺字段: ${k}`);

line('');
line('   真人 cookie：' + (real.cookies.join(', ') || '(无)'));
line('');
line(`（参考）真人 body 里的关键值：${JSON.stringify({
  model_type: real.body?.model_type,
  thinking_enabled: real.body?.thinking_enabled,
  search_enabled: real.body?.search_enabled,
  action: real.body?.action,
  preempt: real.body?.preempt,
  hasShumei: Boolean(real.body?.shumei_device_id),
  shumeiLen: String(real.body?.shumei_device_id || '').length,
  promptLen: String(real.body?.prompt || '').length,
})}`);
line('');
