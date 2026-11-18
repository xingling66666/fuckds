import { chromium } from 'playwright';
import { loadConfig } from './src/config.mjs';
import { PowSolver } from './src/browser/pow.mjs';
const TOKEN='0dH9va8n46uiovqDS8bwrOLlD08mzO1hy1WibiKhRIqrJwhGtXr9aKwgZOBjdF1d';
const DEV='2d70ce31-d4ff-43f6-b7c2-51e857867812';
const UA='Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36 EdgA/157.0.0.0';
const config = loadConfig({}, { store: false });
const pow = new PowSolver({ binPath: config.direct?.powBin || './bin/ds-pow', logger: console });
const b=await chromium.launch({ headless:false, args:['--headless=new'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN', timezoneId:'Asia/Shanghai', viewport:{width:412,height:915}, isMobile:true, hasTouch:true });
await ctx.addInitScript(({t,d})=>{ try{ if(/deepseek\.com$/.test(location.hostname)){ localStorage.setItem('userToken', JSON.stringify({value:t,__version:'0'})); localStorage.setItem('deepseek-device-id:chat', d);} }catch(e){} }, {t:TOKEN,d:DEV});
const p=await ctx.newPage();
await p.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(3000);
console.log('URL:', p.url(), '| userToken?', await p.evaluate(()=>Boolean((JSON.parse(localStorage.getItem('userToken')||'{}')).value)));
const H = (extra={}) => ({ 'content-type':'application/json', authorization:`Bearer ${TOKEN}`, 'x-client-bundle-id':'com.deepseek.chat','x-client-platform':'web','x-client-version':'2.8.0','x-client-locale':'zh_CN','x-client-timezone-offset':'28800','x-device-id':DEV,'x-device-model':'', ...extra });
// 1) 取 PoW（目标：completion）
const ch = await p.evaluate(async (h)=> {
  const r = await fetch('/api/v0/chat/create_pow_challenge',{method:'POST',headers:h,body:JSON.stringify({target_path:'/api/v0/chat/completion'})});
  return { status:r.status, body: await r.text() };
}, H());
console.log('challenge:', ch.status, ch.body.slice(0,160));
let challenge=null; try{ challenge=JSON.parse(ch.body)?.data?.biz_data?.challenge; }catch{}
if (challenge) {
  const solved = await pow.solve({ challenge: challenge.challenge, salt: challenge.salt, expireAt: challenge.expire_at, difficulty: challenge.difficulty });
  const powHeader = Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer: solved.answer, signature: challenge.signature, target_path: challenge.target_path || '/api/v0/chat/completion' })).toString('base64');
  const out = await p.evaluate(async ({h})=>{
    const r = await fetch('/api/v0/chat_session/create',{method:'POST',headers:h,body:JSON.stringify({character_id:null})});
    return { status:r.status, body:(await r.text()).slice(0,200) };
  }, { h: H({'x-ds-pow-response':powHeader}) });
  console.log('create_session(+pow):', JSON.stringify(out));
  const out2 = await p.evaluate(async ({h})=>{
    const r = await fetch('/api/v0/users/current',{method:'GET',headers:h});
    return { status:r.status, body:(await r.text()).slice(0,160) };
  }, { h: H() });
  console.log('users/current:', JSON.stringify(out2));
}
await b.close().catch(()=>{});
