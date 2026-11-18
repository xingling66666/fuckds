// 隔离自检：官方测试 sitekey（本地 file://），验证 a11y 机制本身能否拿 token
import { chromium } from 'playwright';
import { solveA11y, makeAsk, loadCache } from '../src/captcha/a11y.mjs';
const logger = { info: (...a)=>console.log('INFO',...a), warn:(...a)=>console.log('WARN',...a), error:(...a)=>console.log('ERR',...a), debug:()=>{} };
const { loadConfig } = await import('../src/config.mjs');
const { createEngine } = await import('../src/engine.mjs');
const engine = createEngine({ config: loadConfig(process.env, {}), logger });
const ask = makeAsk({ engine, cache: loadCache(), log: logger });
const b = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const pg = await b.newPage();
await pg.goto('file:///root/dsh/hc_test.html');
await pg.waitForTimeout(4000);
// 点 checkbox 触发挑战
await pg.frameLocator('iframe[title*="hCaptcha"], iframe[src*="hcaptcha"]').first().getByRole('checkbox').click({ timeout: 8000 }).catch(async () => {
  const f = pg.frames().find(x => (x.url()||'').includes('hcaptcha.html'));
  if (f) await f.click('#checkbox', { timeout: 5000 }).catch(()=>{});
});
await pg.waitForTimeout(3000);
try {
  const r = await solveA11y(pg, { ask, log: logger });
  console.log('✅ SELFTEST TOKEN:', r.token.slice(0, 24) + '…', '| 题数', r.stats.questions.length);
} catch (e) { console.log('❌ SELFTEST FAIL:', e.message); }
await b.close();
