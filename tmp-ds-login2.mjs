import { chromium } from 'playwright';
const OUT = '/root/opends-freetoken/data/artifacts/login';
const EMAIL = 'xingling66666+ds-test@gmail.com';
const PASS = 'clz646899';
const shot = async (page, n) => { const p = `${OUT}/${n}.png`; await page.screenshot({ path: p }).catch(()=>{}); console.log('SHOT', n); return p; };

const browser = await chromium.launch({ headless: false, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader','--no-first-run'] });
const ctx = await browser.newContext({ viewport:{width:1512,height:950}, locale:'zh-CN', timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' });
await ctx.addInitScript(() => Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = await ctx.newPage();

const reqs = [];
page.on('request', r => { const u = r.url(); if (u.includes('/api/v0/')) reqs.push(r.method()+' '+u.replace('https://chat.deepseek.com','')); });
page.on('response', async r => { const u = r.url(); if (u.includes('/api/v0/')) { let b=''; try{ b = (await r.text()).slice(0,200);}catch{} if (r.status()!==200 || /biz_code|challenge/i.test(b)) console.log('RESP', r.status(), u.replace('https://chat.deepseek.com',''), b); } });

await page.goto('https://chat.deepseek.com/sign_in', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForTimeout(3500);

// 点「密码登录」
await page.getByText('密码登录', { exact:true }).first().click({ timeout:5000 }).catch(e=>console.log('click pw-login fail', e.message));
await page.waitForTimeout(1500);
await shot(page,'03-password-form');
const inputs = await page.locator('input').evaluateAll(els => els.map(e=>({type:e.type, ph:e.placeholder, cls:(e.className||'').slice(0,30)})));
console.log('INPUTS:', JSON.stringify(inputs));
console.log('TEXT:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,300));

// 填邮箱
const emailBox = page.locator('input').filter({ hasNot: page.locator('[type=password]') }).first();
await page.locator('input').nth(0).click();
await page.keyboard.type(EMAIL, { delay: 40 + Math.random()*60 });
await shot(page,'04-email-filled');

// 填密码
const pw = page.locator('input[type=password]').first();
if (await pw.count()) { await pw.click(); await page.keyboard.type(PASS, { delay: 45 + Math.random()*70 }); }
else { await page.locator('input').nth(1).click(); await page.keyboard.type(PASS, { delay: 45 + Math.random()*70 }); }
await shot(page,'05-filled');

await page.getByRole('button', { name: '登录' }).first().click({ timeout:5000 }).catch(async()=>{
  await page.getByText('登录', { exact:true }).last().click().catch(e=>console.log('submit fail', e.message));
});
console.log('== submitted');
await page.waitForTimeout(3000);
await shot(page,'06-after-submit');
await page.waitForTimeout(4000);
await shot(page,'07-after-wait');

console.log('URL:', page.url());
console.log('BODY:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,500));
console.log('API-CALLS:', JSON.stringify(reqs.slice(-20), null, 1));
const ls = await page.evaluate(() => { try { return Object.keys(localStorage); } catch { return []; } });
console.log('LOCALSTORAGE-KEYS:', ls.join(','));
await browser.close();
