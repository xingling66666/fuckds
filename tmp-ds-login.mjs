import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = '/root/opends-freetoken/data/artifacts/login';
const PROFILE = '/root/opends-freetoken/data/artifacts/pw-profile-test';
const EMAIL = 'xingling66666+ds-test@gmail.com';
const PASS = 'clz646899';

const shot = async (page, name) => {
  const p = `${OUT}/${name}.png`;
  await page.screenshot({ path: p, fullPage: false }).catch(e => console.log('shot fail', name, e.message));
  console.log('SHOT', p);
  return p;
};

const browser = await chromium.launch({
  headless: false,
  channel: undefined,
  args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled',
         '--no-first-run','--no-default-browser-check','--use-gl=angle','--use-angle=swiftshader'],
});
const ctx = await browser.newContext({
  viewport: { width: 1512, height: 950 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text().slice(0,160)); });

console.log('== goto');
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
await shot(page, '01-landing');
console.log('TITLE:', await page.title());
console.log('URL:', page.url());
const body = (await page.locator('body').innerText().catch(()=>'' )) || '';
console.log('BODY-TEXT:', body.replace(/\s+/g,' ').slice(0, 400));

// 找登录入口
const loginCandidates = ['登录', 'Log in', 'Sign in', 'Sign In', '登录/注册'];
let clicked = false;
for (const t of loginCandidates) {
  const loc = page.getByText(t, { exact: false }).first();
  if (await loc.count().catch(()=>0)) {
    try { await loc.click({ timeout: 3000 }); clicked = true; console.log('CLICKED', t); break; } catch {}
  }
}
if (!clicked) console.log('NO-LOGIN-BUTTON');
await page.waitForTimeout(2500);
await shot(page, '02-after-login-click');
console.log('INPUTS:', await page.locator('input').count());
const inputs = await page.locator('input').evaluateAll(els => els.map(e => ({type:e.type, name:e.name, ph:e.placeholder, cls:(e.className||'').slice(0,40)})));
console.log('INPUT-LIST:', JSON.stringify(inputs));
await browser.close();
