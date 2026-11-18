import { loadConfig } from './src/config.mjs';
import { loadTokens } from './src/auth.mjs';
import { chromium } from 'playwright';
const config = loadConfig();
const token = loadTokens(config)[0];
const browser = await chromium.launch({ headless: false, args: ['--headless=new','--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 },
});
await ctx.addInitScript(`try{localStorage.setItem('userToken', JSON.stringify({value:${JSON.stringify(token)},__version:'0'}))}catch(e){}`);
const page = await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

const before = await page.evaluate(()=>{
  const m=document.cookie.match(/(?:^|;\s*)\.?thumbcache[^=]*=([^;]*)/i);
  return m?m[1]:null;
});
console.log('注入前 thumbcache 值:', JSON.stringify(before));

// 注入 fp.min.js 并等 id 出现
const out = await page.evaluate(async () => {
  const read = () => {
    const m = document.cookie.match(/(?:^|;\s*)\.?thumbcache[^=]*=([^;]*)/i);
    return m && m[1] ? decodeURIComponent(m[1]) : null;
  };
  if (!read()) {
    await new Promise((res) => {
      const s = document.createElement('script');
      s.src = '/static/fp.min.js';
      s.dataset.fp = 'true';
      s.onload = () => res();
      s.onerror = () => res();
      document.head.appendChild(s);
      setTimeout(res, 15000);
    });
  }
  for (let i = 0; i < 30; i++) {
    const v = read();
    if (v) return { value: v, sdk: typeof window.SMSdk, tries: i };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { value: null, sdk: typeof window.SMSdk };
});
console.log('注入后:', JSON.stringify(out));
await browser.close();
