#!/usr/bin/env node
/**
 * 单独验证 src/captcha/a11y.mjs：
 *   开注册页 -> 填表 -> 点发码 -> 走无障碍题 -> 取 token
 * 用法: node scripts/a11y-try.mjs [proxy]
 */
import { chromium } from 'playwright';
import { solveA11y, makeAsk, findChallengeFrame, loadCache, saveCache } from '../src/captcha/a11y.mjs';
import fs from 'node:fs';

const PROXY = process.argv[2] || 'http://127.0.0.1:7890';
const EMAIL = process.env.DS_EMAIL || `kaiyang.luo1987+hc${Date.now().toString(36)}@gmail.com`;
const PW = process.env.DS_PW || 'Kq7-Vt2mXz9LpR4d';
const T0 = Date.now();
const logger = {
  info: (...a) => console.log(`[${Date.now() - T0}ms]`, ...a),
  warn: (...a) => console.log(`[${Date.now() - T0}ms] WARN`, ...a),
  error: (...a) => console.log(`[${Date.now() - T0}ms] ERR`, ...a),
  debug: () => {},
};
const log = (...a) => logger.info(...a);

const ctx = await chromium.launchPersistentContext('./profile_ds', {
  headless: true,
  proxy: { server: PROXY },
  locale: 'en-US',
  timezoneId: 'Europe/Berlin',
  viewport: { width: 1366, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
});
const page = ctx.pages()[0] || (await ctx.newPage());

await page.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForSelector('input', { timeout: 30000 });
for (const t of ['Accept all cookies', 'Necessary cookies only']) {
  await page.getByText(t, { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
}
const inputs = await page.$$('input');
await inputs[0].fill(EMAIL);
await inputs[1].fill(PW);
await inputs[2].fill(PW);
log('表单已填', EMAIL);
await page.getByText(/^Send code$|发送验证码/).first().click({ timeout: 8000 });
log('已点发码');

// 等挑战帧
let frame = null;
for (let i = 0; i < 200; i += 1) {
  frame = findChallengeFrame(page);
  if (frame) break;
  await page.waitForTimeout(100);
}
log('挑战帧:', frame ? 'ok' : 'MISS');

const cache = loadCache();
let engine = null;
if (process.env.USE_ENGINE !== '0') {
  const { loadConfig } = await import('../src/config.mjs');
  const { createEngine } = await import('../src/engine.mjs');
  engine = createEngine({ config: loadConfig(process.env, {}), logger });
  log('引擎已构造（号池答题）');
}
const baseAsk = makeAsk({ engine, cache, log: logger });
const seen = [];
const ask = async (q) => {
  const t = Date.now();
  const a = await baseAsk(q);
  seen.push({ q, a, ms: Date.now() - t });
  log(`  A(${Date.now() - t}ms) ${JSON.stringify(a)}`);
  return a;
};
let out;
try {
  out = await solveA11y(page, { ask, log: logger, rounds: 4 });
  log('✅ TOKEN', out.token.slice(0, 40) + '…');
} catch (err) {
  log('❌', err.message);
}
log('统计', JSON.stringify(out?.stats || {}, null, 1));
saveCache(cache);
fs.writeFileSync('/root/dsh/a11y_seen.json', JSON.stringify(seen, null, 1));
log('本次题目', seen.length, '未覆盖', seen.filter((x) => !x.a).length);
await page.screenshot({ path: '/root/dsh/shots/js_a11y.png' });
await ctx.close();
process.exit(0);
