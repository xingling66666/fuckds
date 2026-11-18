import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='/root/opends-freetoken/data/artifacts/login-now';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const mask=v=>!v?'':(v.length>26? v.slice(0,12)+'…'+v.slice(-6)+` [${v.length}]` : v);

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  window.__plain=[]; 
  const oe=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt=async function(a,k,d){try{if(a&&a.name==='AES-CBC'&&d)window.__plain.push(new TextDecoder().decode(new Uint8Array(d)));}catch{} return oe(a,k,d);};
});
const page=await ctx.newPage();

const log=[];
page.on('request', r=>{ const u=r.url(); if(!u.includes('/api/v0/'))return;
  const p=u.replace('https://chat.deepseek.com','');
  if(/users\/login|guest_challenge|mfa|challenge|verification/i.test(p)) {
    log.push({dir:'->', m:r.method(), p, h:Object.entries(r.headers()).filter(([k])=>/guest-pow|x-ds-|encryption|content-type/i.test(k)).map(([k,v])=>`${k}: ${/pow|encryption/i.test(k)?mask(v):v}`), body:(r.postData()||'').slice(0,220)});
  }});
page.on('response', async r=>{ const u=r.url(); const p=u.replace('https://chat.deepseek.com','');
  if(!/users\/login|guest_challenge|mfa|challenge|verification/i.test(p)) return;
  let b=''; try{b=(await r.text()).slice(0,600)}catch{}
  const h=r.headers(); const flags={}; for(const k of ['x-amzn-waf-action','cf-mitigated','x-ds-trace-id']) if(h[k]) flags[k]=h[k];
  log.push({dir:'<-', s:r.status(), p, flags, body:b.replace(/\s+/g,' ')});
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(7000);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000}).catch(()=>{});
await page.waitForSelector('input[type=password]',{timeout:15000});
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
await page.waitForTimeout(1500);
await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(()=>{});
await page.waitForTimeout(6000);
console.log('URL after login attempt:', page.url());
const bodyTxt = (await page.locator('body').innerText()).replace(/\s+/g,' ');
console.log('HAS-MFA-MODAL:', /验证账号|发送验证码/.test(bodyTxt));
await page.screenshot({path:`${OUT}/10-mfa-modal.png`});

// 点「发送验证码」
const sendCandidates = [
  page.getByText('发送验证码',{exact:true}).last(),
  page.locator('div.ds-button',{hasText:'发送验证码'}).last(),
];
let clicked=false;
for(const c of sendCandidates){
  if(await c.count().catch(()=>0)){
    try{ await c.click({timeout:6000}); clicked=true; console.log('CLICKED 发送验证码'); break; }catch(e){ console.log('click fail:', e.message.split('\n')[0]); }
  }
}
if(!clicked) console.log('NO 发送验证码 ELEMENT');
await page.waitForTimeout(7000);
await page.screenshot({path:`${OUT}/11-after-send.png`});
const txt2=(await page.locator('body').innerText()).replace(/\s+/g,' ');
console.log('AFTER-TEXT:', txt2.slice(-260));
console.log('\n===== NETWORK =====');
for(const e of log){
  if(e.dir==='->'){ console.log(`\n-> ${e.m} ${e.p}`); if(e.h.length) console.log('   ', e.h.join('\n    ')); if(e.body) console.log('    body:', e.body); }
  else { console.log(`<- ${e.s} ${e.p} ${JSON.stringify(e.flags)}`); console.log('   ', e.body); }
}
const plains = await page.evaluate(()=>window.__plain);
console.log('\n===== 加密前明文 =====');
for(const p of plains) console.log(' ', p.replace(/"password":"[^"]*"/,'"password":"***"').slice(0,300));
await browser.close();
