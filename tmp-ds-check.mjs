import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='/root/opends-freetoken/data/artifacts/login-now';
fs.mkdirSync(OUT,{recursive:true});
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const shot=async(p,n)=>{await p.screenshot({path:`${OUT}/${n}.png`}).catch(e=>console.log('shot err',e.message));console.log('SHOT',n);};

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  window.__plain=null; window.__cap=[];
  const oe=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt=async function(a,k,d){try{if(a&&a.name==='AES-CBC'&&d)window.__plain=new TextDecoder().decode(new Uint8Array(d));}catch{} return oe(a,k,d);};
});
const page=await ctx.newPage();

page.on('response', async r=>{
  const u=r.url();
  if(!u.includes('/api/v0/')) return;
  if(!/users\/login|create_guest_challenge|challenge/.test(u)) return;
  let b=''; try{b=(await r.text()).slice(0,800);}catch{}
  console.log('\n>>', r.status(), u.replace('https://chat.deepseek.com',''));
  const h=r.headers(); for(const k of ['x-amzn-waf-action','cf-mitigated','x-ds-trace-id']) if(h[k]) console.log('   ',k+':',h[k]);
  console.log('   body:', b.replace(/\s+/g,' ').slice(0,600));
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(7000);
console.log('URL0:', page.url());
await shot(page,'01-landing');

// 如果已经是登录页
let mode='unknown';
if(/sign_in/.test(page.url())){
  const hasPw = await page.locator('input[type=password]').count();
  if(!hasPw) { await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000}).catch(e=>console.log('toggle',e.message)); await page.waitForTimeout(1200); }
  mode = (await page.locator('input[type=password]').count()) ? 'password-form' : 'unknown';
  console.log('FORM MODE:', mode);
  await shot(page,'02-form');
  if(mode==='password-form'){
    const boxes=page.locator('input');
    await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:60});
    await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:70});
    await page.waitForTimeout(1500);
    await shot(page,'03-filled');
    await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(e=>console.log('submit?',e.message));
    for(const [i,ms] of [[1,3000],[2,3000],[3,4000],[4,5000]]){ await page.waitForTimeout(ms); await shot(page,`04-after-submit-${i}`); }
  }
}
console.log('URL1:', page.url());
const info = await page.evaluate(()=>({
  plain: window.__plain,
  token: (()=>{try{return JSON.parse(localStorage.getItem('userToken')||'null')?.value||null}catch{return null}})(),
  iframes: [...document.querySelectorAll('iframe')].map(f=>({src:(f.src||'').slice(0,120), w:f.clientWidth, h:f.clientHeight})),
  bodyText: document.body.innerText.replace(/\s+/g,' ').slice(0,300),
  hcaptcha: typeof window.hcaptcha, SM: typeof window.SMSdk,
}));
console.log('\n=== PAGE STATE ===');
console.log('token:', info.token? 'YES len='+info.token.length : 'none');
console.log('plain(login body):', (info.plain||'(none)').replace(/"password":"[^"]*"/,'"password":"***"'));
console.log('iframes:', JSON.stringify(info.iframes));
console.log('hcaptcha global:', info.hcaptcha, ' SMSdk:', info.SM);
console.log('bodyText:', info.bodyText);
await shot(page,'05-final');
await browser.close();
