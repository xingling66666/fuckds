// 用已有的验证码直接完成注册（不重发码），成功后写号池
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';
import { openTokenStore } from '../src/token-store.mjs';

const EMAIL = process.argv[2];
const CODE = process.argv[3];
const PW = process.argv[4] || 'Kq7-Vt2mXz9LpR4d';
const PROXY = process.env.CLASH || 'http://127.0.0.1:7890';
const log = (...a) => console.log(...a);

const ctx = await chromium.launchPersistentContext('./profile_fin', {
  headless: true, proxy: { server: PROXY }, locale: 'en-US', timezoneId: 'Europe/Berlin',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const pg = ctx.pages()[0] || await ctx.newPage();
const hits = [];
pg.on('response', async (r) => {
  if (!/\/api\/v0\/users\//.test(r.url())) return;
  let body = ''; try { body = (await r.text()).slice(0, 300); } catch {}
  hits.push({ s: r.status(), u: r.url().split('/api')[1], body });
});
for (let attempt = 0; attempt < 4; attempt++) {
  try {
    await pg.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await pg.waitForSelector('input', { timeout: 30000 });
    const n = (await pg.$$('input')).length;
    log(`attempt ${attempt}: inputs=${n}`);
    if (n >= 3) break;
  } catch (e) {
    log(`attempt ${attempt} 重试: ${e.message.split('\n')[0].slice(0, 70)}`);
    await pg.waitForTimeout(3000);
  }
}
for (const t of ['Accept all cookies', 'Necessary cookies only']) {
  await pg.getByText(t, { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
}
// 补设备号（否则 register 返回 422 body.device_id）
// 站内存储形如 {"value": "...", "__version": "0"}
const uuid = crypto.randomUUID();
const hex = await pg.evaluate((u) => {
  const keys = ['deepseek-device-id:chat', 'deepseek-device-id'];
  for (const k of keys) localStorage.setItem(k, JSON.stringify({ value: u, __version: '0' }));
  return keys.map((k) => k + '=' + localStorage.getItem(k));
}, uuid).catch((e) => 'ERR ' + e.message);
log('device-id 写入:', JSON.stringify(hex).slice(0, 160));
await pg.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await pg.waitForSelector('input', { timeout: 30000 }).catch(() => {});
await pg.waitForTimeout(1500);
const ins = await pg.$$('input');
log('inputs:', ins.length, '| text:', (await pg.evaluate(() => document.body.innerText)).slice(0, 90).replace(/\n/g, ' | '));
await ins[0].fill(EMAIL);
await ins[1].fill(PW);
await ins[2].fill(PW);
// 点发码（只为把 code 输入框渲染出来；新码会覆盖旧的，所以先直接填旧码试一次不点）
await pg.screenshot({ path: '/root/dsh/shots/fin_before.png' });
const hasCodeInput = (await pg.$$('input[type="tel"], input[placeholder*="Code" i]')).length > 0;
log('code input present before send:', hasCodeInput);
if (!hasCodeInput) {
  log('→ 需要先点 Send code 才会出现验证码框（会重发新码）');
}
// 验证码输入框默认就在（不要点 Send code，否则会重渲染清空表单并重发新码）
let codeVal = CODE;
if (!codeVal) {
  const fsx = await import('node:fs');
  const f = '/root/dsh/code.txt';
  log('等待验证码文件', f, '（最多 10 分钟）');
  const dl = Date.now() + 10 * 60_000;
  while (Date.now() < dl) {
    const raw = fsx.existsSync(f) ? fsx.readFileSync(f, 'utf8') : '';
    const hit = raw.match(/\b(\d{6})\b/);
    if (hit) { codeVal = hit[1]; fsx.writeFileSync(f, ''); break; }
    await pg.waitForTimeout(1500);
  }
}
if (!codeVal) { log('❌ 没等到验证码'); await ctx.close(); process.exit(1); }
log('使用验证码:', codeVal);
// 重填（防止被重渲染清空）
const ins3 = await pg.$$('input');
await ins3[0].fill(EMAIL);
await ins3[1].fill(PW);
await ins3[2].fill(PW);
const ins2 = await pg.$$('input');
const code = ins2[ins2.length - 1];
await code.fill(codeVal);
await pg.waitForTimeout(500);
const cb = await pg.$('input[type="checkbox"], .checkbox, [class*="checkbox"]');
if (cb) await cb.click({ timeout: 2000 }).catch(() => {});
await pg.getByText(/^Sign up$|^注册$/).first().click({ timeout: 8000 }).catch(e => log('signup click err', e.message.slice(0, 60)));
await pg.waitForTimeout(9000);
log('page text after submit:', (await pg.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n/g, ' | '));
const token = await pg.evaluate(() => {
  try { const raw = localStorage.getItem('userToken'); if (!raw) return ''; const v = JSON.parse(raw).value; return typeof v === 'string' ? v : v?.jwt || ''; } catch { return ''; }
});
log('--- API ---'); for (const h of hits) log(h.s, h.u, '|', h.body);
log('userToken:', token ? token.slice(0, 10) + '… len ' + token.length : 'NONE');
await pg.screenshot({ path: '/root/dsh/shots/fin_after.png' });
if (token) {
  const config = loadConfig(process.env, {});
  const store = openTokenStore({ dataDir: config.dataDir });
  store.add(token, { source: 'register-outlook', note: EMAIL });
  log('✅ 已入号池:', store.list().length, '个');
}
await ctx.close();
process.exit(0);
