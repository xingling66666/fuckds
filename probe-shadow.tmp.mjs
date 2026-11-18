import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const b=await chromium.launch({ headless:false, args:['--headless=new','--disable-blink-features=AutomationControlled'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN', timezoneId:'Asia/Shanghai', viewport:{width:1440,height:900} });
const p=await ctx.newPage();
await p.goto('https://chat.deepseek.com/sign_up', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(12000);
await p.getByText('仅接受必要 Cookies').click({ timeout: 3000 }).catch(()=>{});
await p.locator('input[type="text"], input:not([type])').first().fill(`sh${Date.now()}@fldubai.com`).catch(()=>{});
await p.locator('input[type="password"]').first().fill('Px12345678!').catch(()=>{});
await p.getByText('发送验证码', { exact: false }).first().click({ timeout: 8000 }).catch(()=>{});
await p.waitForTimeout(9000);
const f = p.frames().find(x=>x.url().includes('hcaptcha.com/captcha'));
if (!f) { console.log('没有 challenge frame（本次没触发）'); await b.close(); process.exit(0); }
// 用 locator 穿透 shadow DOM 找可见单元格
const counts = {};
for (const sel of ['div[role="button"]','div[class*="cell"]','[style*="grid"] > div','div[class*="challenge"]','button','img','canvas']) {
  counts[sel] = await f.locator(sel).count().catch(()=>-1);
}
console.log('locator 计数:', JSON.stringify(counts));
const text = await f.locator('body').innerText().catch(()=>'');
console.log('题面:', text.replace(/\s+/g,' ').slice(0,100));
// 列出所有可见小方块的位置（locator 穿透 shadow）
const boxes = await f.locator('div').evaluateAll(els => els.map(el => { const r = el.getBoundingClientRect(); return { t: (el.textContent||'').trim().slice(0,3), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }).filter(o => o.w >= 30 && o.w <= 110 && o.h >= 30 && o.h <= 110).slice(0, 30)).catch(()=>[]);
console.log('候选方块数:', boxes.length);
console.log(JSON.stringify(boxes.slice(0, 12)));
await b.close().catch(()=>{});
