#!/usr/bin/env node
/**
 * 出口预检：10 秒判断这个 IP 能不能走「邮箱注册」这条路。
 * 用法: node scripts/preflight.mjs [proxy]
 *
 * 输出:
 *   IP / 地区 / ASN
 *   注册方式: email | phone | blocked
 *   是否需要 WAF 强挑战
 *   hCaptcha checksiteconfig 的 pass 值
 */
import { chromium } from 'playwright';

const PROXY = process.argv[2] || process.env.CLASH || 'http://127.0.0.1:7890';
const log = (...a) => console.log(...a);

// 1) 出口 IP
const ipinfo = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(12000) }).catch(() => null);
if (ipinfo && ipinfo.ok) {
  const d = await ipinfo.json();
  log(`IP      : ${d.ip}`);
  log(`地区    : ${d.country} / ${d.region} / ${d.city}`);
  log(`ASN     : ${d.org}`);
}

// 2) hCaptcha 站点配置
const csc = await fetch(
  'https://hcaptcha.com/checksiteconfig?host=chat.deepseek.com&sitekey=352e5376-f2cc-43fe-a744-e51640449610&sc=1&swa=1',
  { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' } },
).catch(() => null);
if (csc && csc.ok) {
  const j = await csc.json().catch(() => ({}));
  log(`hCaptcha: pass=${j.pass} type=${j?.c?.type || '-'}`);
}

// 3) 注册页到底给哪种注册方式
const b = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await b.newContext({
  proxy: { server: PROXY },
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
});
const pg = await ctx.newPage();
const waf = [];
pg.on('response', (r) => {
  const h = r.headers();
  if (r.url().includes('chat.deepseek.com') && (h['x-amzn-waf-action'] || r.status() === 202)) waf.push(r.status());
});
let mode = 'unknown';
let text = '';
for (let i = 0; i < 3; i++) {
  await pg.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await pg.waitForTimeout(4000);
  const inputs = await pg.$$('input').catch(() => []);
  text = (await pg.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ');
  const hasEmail = await pg.$eval('input[type="text"], input:not([type])', () => true).catch(() => false);
  const hasTel = await pg.$eval('input[type="tel"], input[placeholder*="phone" i]', () => true).catch(() => false);
  if (hasEmail && inputs.length >= 3) { mode = 'email'; break; }
  if (hasTel && /phone/i.test(text)) { mode = 'phone'; break; }
  if (/phone number registration|手机号注册/i.test(text)) { mode = 'phone'; break; }
  await pg.waitForTimeout(2000);
}
log(`页面    : ${text.slice(0, 120)}`);
log(`WAF     : ${waf.length ? '强挑战(' + waf.join(',') + ')' : '静默/无'}`);
log(`注册方式: ${mode === 'email' ? '✅ 支持邮箱注册（可以跑）' : mode === 'phone' ? '❌ 仅手机号（换节点）' : '❓ 未知（可能被挡）'}`);
await b.close();
process.exit(mode === 'email' ? 0 : 2);
