import { chromium } from 'playwright';
const RAW = {"value":{"ownerHash":"f02a8e30bb882","jwt":"eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..3ALg1nQICWqtQH_F.kgPRhYakkW8WHrkC2qK8TOwXOm1I52kM2q5XNW4_hOetdgENwwxMQXDRunNBoFFzsHwO3EijeAPxewHiCZxG7-9NUSCQD7bkPwz6xu3Pl_kW5lnyJ6-XYEZ9N3WhKYEMG7TKSjA8qSHrwobamKEMZQYmZJQ-_HOHVqh8d_uy25bxPH4th-YuAUCl5_nXZGR2j4QTh27JckWAlS0yU6oe4gw9n-LCbnDDFposBk24ziuKIJaxKtlz_tq_WgSPML7gRq3ew6_CZQ.0tLcUuQEI7ysVTe3qHBy9g"},"__version":"0"};
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const b=await chromium.launch({ headless:false, args:['--headless=new'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN', timezoneId:'Asia/Shanghai' });
await ctx.addInitScript((raw)=>{
  try{ if(/deepseek\.com$/.test(location.hostname)) localStorage.setItem('userToken', JSON.stringify(raw)); }catch(e){}
  try{
    const record=(v)=>{ if(typeof v==='string'&&v.toLowerCase().startsWith('bearer ')) window.__dsLastAuth=v.slice(7).trim(); };
    const of=window.fetch;
    window.fetch=function(i,init){ try{ const h=(init&&init.headers)||(i&&i.headers); if(h){ if(typeof h.get==='function') record(h.get('authorization')); else if(Array.isArray(h)) for(const [k,v] of h) if(String(k).toLowerCase()==='authorization') record(v); else for(const [k,v] of Object.entries(h)) if(String(k).toLowerCase()==='authorization') record(v);} }catch(e){} return of.apply(this,arguments); };
  }catch(e){}
}, RAW);
const p=await ctx.newPage();
await p.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(6000);
const st = await p.evaluate(()=>({ url:location.pathname, lastAuth: (window.__dsLastAuth||'').slice(0,20), hasAuth: Boolean(window.__dsLastAuth) }));
console.log('结果:', JSON.stringify(st));
await b.close().catch(()=>{});
