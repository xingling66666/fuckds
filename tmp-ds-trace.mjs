import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT='/root/opends-freetoken/data/artifacts/trace';
fs.mkdirSync(OUT,{recursive:true});
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const mask=v=>!v?'':(v.length>24? v.slice(0,12)+'…'+v.slice(-6)+` [len ${v.length}]` : v);

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  window.__T = { t0: 0, events: [], xhr: [], fetch: [], plain: null, sse: [] };
  const now = () => (window.__T.t0 ? Math.round(performance.now()-window.__T.t0) : Math.round(performance.now()));
  window.__mark = (k, extra) => window.__T.events.push({ t: now(), k, ...(extra||{}) });
  // 加密前明文
  const oe = crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt = async function(a,k,d){ try{ if(a&&a.name==='AES-CBC'&&d) window.__T.plain = new TextDecoder().decode(new Uint8Array(d)); }catch{} return oe(a,k,d); };
  // XHR 钩子
  const XO=XMLHttpRequest.prototype.open, XS=XMLHttpRequest.prototype.send, XH=XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open=function(m,u){ this.__m=m; this.__u=u; this.__h={}; return XO.apply(this,arguments); };
  XMLHttpRequest.prototype.setRequestHeader=function(k,v){ try{ this.__h[k]=v; }catch{} return XH.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(b){
    const rec={ m:this.__m, u:String(this.__u), h:{...this.__h}, body: (typeof b==='string'?b.slice(0,600):'<'+typeof b+'>'), t:now(), chunks:0, bytes:0 };
    window.__T.xhr.push(rec);
    this.addEventListener('progress', () => { const r=this.responseText||''; rec.chunks++; rec.bytes=r.length; if(!rec.firstByteAt){ rec.firstByteAt=now(); window.__mark('first-sse-byte',{url:rec.u}); } });
    this.addEventListener('loadend', ()=>{ rec.doneAt=now(); rec.status=this.status; });
    return XS.apply(this,arguments);
  };
  // fetch 钩子
  const of=window.fetch;
  window.fetch=function(input,init){
    try{ const u=typeof input==='string'?input:(input&&input.url)||''; if(u.includes('/api/v0/')) window.__T.fetch.push({u, at:now(), method:(init&&init.method)||'GET', body:(init&&typeof init.body==='string')?init.body.slice(0,400):''}); }catch{}
    return of.apply(this,arguments);
  };
  // 键盘/提交事件
  document.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey) window.__mark('keydown-enter',{isTrusted:e.isTrusted}); }, true);
  document.addEventListener('submit', e=>window.__mark('form-submit',{isTrusted:e.isTrusted}), true);
});

const page=await ctx.newPage();
const allReq=[];
page.on('request', r=>{ const u=r.url(); if(!u.includes('/api/v0/'))return;
  allReq.push({ ts:Date.now(), m:r.method(), u:u.replace('https://chat.deepseek.com',''), h:r.headersArray(), body:r.postData()?.slice(0,500)||'' }); });

async function login(){
  await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
  await page.waitForTimeout(6000);
  await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000});
  await page.waitForSelector('input[type=password]',{timeout:15000});
  await page.waitForTimeout(1200);
  const boxes=page.locator('input');
  await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
  await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
  await page.waitForTimeout(1200);
  for(let i=1;i<=6;i++){
    await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(()=>{});
    await page.waitForTimeout(5000);
    if(!/sign_in/.test(page.url())) { console.log('LOGIN OK on attempt', i); break; }
    const p=await page.evaluate(()=>window.__T.plain||'');
    const dev=/"device_id":([^,]*)/.exec(p)?.[1];
    console.log(`attempt ${i}: still sign_in, device_id=${dev}`);
    await page.waitForTimeout(2500);
  }
  console.log('URL after login:', page.url());
}

await login();
if(/sign_in/.test(page.url())) { console.log('LOGIN FAILED, abort'); await browser.close(); process.exit(0); }

// 准备发消息：重置计时
await page.evaluate(()=>{ window.__T.events=[]; window.__T.xhr=[]; window.__T.fetch=[]; window.__T.sse=[]; });
await page.waitForTimeout(2500);
await page.locator('textarea').first().click();
await page.evaluate(()=>{ window.__T.t0 = performance.now(); window.__mark('t0-before-typing'); });

await page.keyboard.type('你好，用一句话介绍你自己', { delay: 70 });
await page.waitForTimeout(900);
await page.evaluate(()=>window.__mark('before-enter'));
await page.keyboard.press('Enter');

// 捕捉 SSE 原文
const sseLines=[];
page.on('response', async r=>{
  if(!r.url().includes('/api/v0/chat/completion')) return;
  console.log('\n=== COMPLETION RESPONSE', r.status(), '| content-type:', r.headers()['content-type']);
  console.log('    resp headers:', JSON.stringify(r.headers(), null, 0).slice(0,600));
});
await page.waitForTimeout(15000);

const T = await page.evaluate(()=>({ events: window.__T.events, xhr: window.__T.xhr, fetch: window.__T.fetch, plain: window.__T.plain }));
console.log('\n=========== JS TIMELINE (ms) ===========');
for(const e of T.events) console.log(String(e.t).padStart(6), 'ms', e.k, JSON.stringify({...e,k:undefined,t:undefined}));

console.log('\n=========== XHR CALLS (sniffed) ===========');
for(const x of T.xhr) {
  console.log(`\n@${x.t}ms  ${x.m} ${x.u.replace('https://chat.deepseek.com','')}  status=${x.status??'-'}  firstByte@${x.firstByteAt??'-'}ms  chunks=${x.chunks} bytes=${x.bytes} done@${x.doneAt??'-'}ms`);
  for(const [k,v] of Object.entries(x.h)) console.log(`   ${k}: ${/authorization|pow-response|encryption-key|settings-token/i.test(k)?mask(v):v}`);
  if(x.body) console.log('   BODY:', x.body.slice(0,300));
}
await page.screenshot({path:`${OUT}/trace-reply.png`});
fs.writeFileSync(`${OUT}/trace.json`, JSON.stringify({T, allReq}, null, 1));
console.log('\nSAVED', `${OUT}/trace.json`);
console.log('PAGE TAIL:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(-300));
await browser.close();
