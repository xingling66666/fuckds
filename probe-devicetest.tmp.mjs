import { chromium } from 'playwright';
const TOKEN='0dH9va8n46uiovqDS8bwrOLlD08mzO1hy1WibiKhRIqrJwhGtXr9aKwgZOBjdF1d';
const DEV='2d70ce31-d4ff-43f6-b7c2-51e857867812';
const SHUMEI='BJik4Cy58SyefHYDdlgYKdN7bQNSj0WucvfP3oyRMvf5NiuMOCuLE7MODVCRfJhJ67fQnk42dYhimGCEAFq/InQ==';
const UA='Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36 EdgA/157.0.0.0';
const b=await chromium.launch({ headless:false, args:['--headless=new'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN', timezoneId:'Asia/Shanghai', viewport:{width:412,height:915}, isMobile:true, hasTouch:true, deviceScaleFactor:2.6 });
await ctx.addInitScript(({t,d})=>{ try{ if(/(^|\.)deepseek\.com$/.test(location.hostname)){ localStorage.setItem('userToken', JSON.stringify({value:t,__version:'0'})); localStorage.setItem('deepseek-device-id:chat', d);} }catch(e){} }, {t:TOKEN,d:DEV});
const p=await ctx.newPage();
await p.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(4000);
console.log('URL:', p.url());
const out = await p.evaluate(async ({dev, shumei}) => {
  const tok = JSON.parse(localStorage.getItem('userToken')||'{}').value || '';
  const H = {
    'content-type':'application/json',
    authorization:`Bearer ${tok}`,
    'x-client-bundle-id':'com.deepseek.chat',
    'x-client-platform':'web',
    'x-client-version':'2.8.0',
    'x-client-locale':'zh_CN',
    'x-client-timezone-offset':'28800',
    'x-device-id':dev,
    'x-device-model':'',
  };
  const r = await fetch('/api/v0/chat_session/create',{method:'POST',headers:H,body:JSON.stringify({character_id:null})});
  const t = await r.text();
  return { status:r.status, body:t.slice(0,200), hasToken:Boolean(tok) };
}, { dev:DEV, shumei:SHUMEI });
console.log('create_session:', JSON.stringify(out));
await b.close().catch(()=>{});
