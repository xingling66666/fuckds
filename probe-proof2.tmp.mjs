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
await page.waitForTimeout(8000);

const info = await page.evaluate(async () => {
  const ls = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=String(localStorage.getItem(k)).slice(0,40);}
  const cookies = document.cookie.split(';').map(c=>c.trim().split('=')[0]);
  const probe = async (url) => {
    try { const r = await fetch(url, { headers: { accept: '*/*' }, credentials: 'include' });
      const text = await r.text();
      return { url, status: r.status, ttl: r.headers.get('x-hif-ttl'), body: text.slice(0, 200) };
    } catch (e) { return { url, error: String(e.message).slice(0,80) }; }
  };
  return { cookies, ls, hif: [await probe('https://hif-leim.deepseek.com/query'), await probe('https://hif-dliq.deepseek.com/query')] };
});
console.log('cookies:', info.cookies.join(', '));
const t=await page.evaluate(()=>{
  const m=document.cookie.match(/(?:^|;\s*)\.?thumbcache[^=]*=([^;]+)/i);
  const lsKey=Object.keys(localStorage).find(k=>/thumbcache/i.test(k));
  return {cookieMatch: m?m[1].slice(0,20):null, lsKey, lsVal: lsKey?String(localStorage.getItem(lsKey)).slice(0,30):null, hifCached: localStorage.getItem('hif_leim_cached')?.slice(0,60)};
});
console.log('thumbcache 细节:', JSON.stringify(t));
const all = await ctx.cookies();
console.log('全部 cookie:', JSON.stringify(all.map(c=>({name:c.name.slice(0,40), value:String(c.value).slice(0,40), httpOnly:c.httpOnly})), null, 1).slice(0,1200));
console.log('localStorage keys:', Object.keys(info.ls).join(', '));
console.log('hif:', JSON.stringify(info.hif, null, 1).slice(0, 800));
await browser.close();
