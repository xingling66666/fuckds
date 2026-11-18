import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const b=await chromium.launch({ headless:false, args:['--headless=new'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN' });
const p=await ctx.newPage();
await p.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(3000);
const res = await p.evaluate(async () => {
  const srcs = [...document.querySelectorAll('script[src]')].map(s=>s.src).filter(u=>/\.js/.test(u));
  const out = { srcs: srcs.slice(0,8), hits: [] };
  for (const src of srcs) {
    try {
      const text = await fetch(src).then(r=>r.text());
      if (text.includes('ownerHash')) {
        const idx = text.indexOf('ownerHash');
        out.hits.push({ src: src.slice(-40), size: text.length, ctx: text.slice(Math.max(0,idx-300), idx+300) });
      }
    } catch(e) {}
  }
  out.localStorageKeys = Object.keys(localStorage);
  return out;
});
console.log('脚本数:', res.srcs.length, '| localStorage keys:', JSON.stringify(res.localStorageKeys));
for (const h of res.hits.slice(0,2)) { console.log('\n=== 命中', h.src, 'size', h.size, '===\n', h.ctx.replace(/\s+/g,' ').slice(0,600)); }
if (!res.hits.length) console.log('(bundle 里没找到 ownerHash，可能在被懒加载的分包里)');
await b.close().catch(()=>{});
