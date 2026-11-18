// 导出我们自动化下 /api/v0/users/* 的真实请求头（用于和人工注册的包做 diff）
import { chromium } from 'playwright';
const { solveA11y, makeAsk, loadCache } = await import('../src/captcha/a11y.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { createEngine } = await import('../src/engine.mjs');

const EMAIL = process.argv[2] || `probe${Date.now().toString(36)}@gmail.com`;
const logger = { info: (...a) => console.log('[I]', ...a), warn: (...a) => console.log('[W]', ...a), error: (...a) => console.log('[E]', ...a), debug: () => {} };
const engine = createEngine({ config: loadConfig(process.env, {}), logger });

const ctx = await chromium.launchPersistentContext('./profile_hdr', {
  headless: true, proxy: { server: 'http://127.0.0.1:7890' }, locale: 'en-US', timezoneId: 'Europe/Berlin',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const pg = ctx.pages()[0] || await ctx.newPage();
const seen = [];
pg.on('request', async (r) => {
  if (!/\/api\/v0\/users\//.test(r.url())) return;
  let h = {};
  try { h = await r.allHeaders(); } catch {}
  seen.push({ url: r.url().split('/api')[1], method: r.method(), headers: h, bodyLen: (r.postData() || '').length });
});
for (let i = 0; i < 4; i++) {
  try {
    await pg.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await pg.waitForSelector('input', { timeout: 30000 });
    if ((await pg.$$('input')).length >= 3) break;
  } catch { await pg.waitForTimeout(3000); }
}
for (const t of ['Accept all cookies', 'Necessary cookies only']) {
  await pg.getByText(t, { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
}
const ins = await pg.$$('input');
await ins[0].fill(EMAIL); await ins[1].fill('Kq7-Vt2mXz9LpR4d'); await ins[2].fill('Kq7-Vt2mXz9LpR4d');
logger.info('表单已填，点发码');
await pg.getByText(/^Send code$|发送验证码/).first().click({ timeout: 8000 }).catch(() => {});
try { await solveA11y(pg, { ask: makeAsk({ engine, cache: loadCache(), log: logger }), log: logger }); } catch (e) { logger.warn('a11y:', e.message); }
await pg.waitForTimeout(4000);
console.log('\n=== 我们的请求头 ===');
for (const s of seen) {
  console.log(`\n${s.method} ${s.url}  (body ${s.bodyLen} bytes)`);
  for (const [k, v] of Object.entries(s.headers)) console.log(`  ${k}: ${String(v).slice(0, 110)}`);
}
await ctx.close(); process.exit(0);
