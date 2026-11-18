// 诊断：真实点击 Send code，抓 create_email_verification_code 的响应体
import { chromium } from 'playwright';
const EMAIL = process.argv[2];
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
  let body = '';
  try { body = (await r.text()).slice(0, 400); } catch {}
  hits.push({ status: r.status(), url: r.url().split('/api')[1], body });
});
for (let i = 0; i < 4; i++) {
  try {
    await pg.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await pg.waitForSelector('input', { timeout: 30000 });
    if ((await pg.$$('input')).length >= 3) break;
  } catch (e) { await pg.waitForTimeout(3000); }
}
for (const t of ['Accept all cookies', 'Necessary cookies only']) {
  await pg.getByText(t, { exact: true }).first().click({ timeout: 1500 }).catch(() => {});
}
const ins = await pg.$$('input');
await ins[0].fill(EMAIL);
await ins[1].fill('Kq7-Vt2mXz9LpR4d');
await ins[2].fill('Kq7-Vt2mXz9LpR4d');
log('filling done for', EMAIL);
await pg.getByText(/^Send code$|发送验证码/).first().click({ timeout: 8000 }).catch(e => log('click err', e.message.slice(0,60)));
await pg.waitForTimeout(6000);
log('--- API ---');
for (const h of hits) log(h.status, h.url, '|', h.body);
log('--- toast/page ---');
log((await pg.evaluate(() => document.body.innerText)).replace(/\n/g,' | ').slice(0, 300));
await pg.screenshot({ path: '/root/dsh/shots/sendcode.png' });
await ctx.close();
process.exit(0);
