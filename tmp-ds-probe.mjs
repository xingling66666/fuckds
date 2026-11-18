import { chromium } from 'playwright';
const browser = await chromium.launch({ headless:false, args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ viewport:{width:1512,height:950}, locale:'zh-CN', timezoneId:'Asia/Shanghai' });
const page = await ctx.newPage();
await page.goto('https://chat.deepseek.com/sign_in', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForTimeout(3000);
const info = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length === 0 && el.textContent && el.textContent.trim() === '密码登录') {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({ tag: el.tagName, cls: el.className, rect: [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                 vis: cs.visibility, disp: cs.display, op: cs.opacity, parent: el.parentElement?.tagName + '.' + (el.parentElement?.className||'') });
    }
  });
  return out;
});
console.log(JSON.stringify(info, null, 1));
// 打印底部区域的可点击元素
const links = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('a,button,span').forEach(el => {
    const t = (el.textContent||'').trim();
    if (['密码登录','注册','使用 Apple 账号登录','登录'].includes(t)) {
      const r = el.getBoundingClientRect();
      if (r.width>0 && r.height>0) out.push({ t, tag: el.tagName, cls: (el.className||'').slice(0,50), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
    }
  });
  return out;
});
console.log('VISIBLE-CLICKABLES:', JSON.stringify(links, null, 1));
await browser.close();
