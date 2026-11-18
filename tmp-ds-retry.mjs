import { chromium } from 'playwright';
const PROF='/root/opends-freetoken/data/artifacts/pw-profile';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const ctx=await chromium.launchPersistentContext(PROF,{headless:false,viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  const orig=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt=async function(a,k,d){try{if(a&&a.name==='AES-CBC'&&d)window.__plain=new TextDecoder().decode(new Uint8Array(d));}catch{} return orig(a,k,d);};
});
const page=ctx.pages()[0]??await ctx.newPage();
let resp=null;
page.on('response', async r=>{ if(r.url().includes('/api/v0/users/login')){ resp={status:r.status(),body:(await r.text().catch(()=>'')).slice(0,120)}; }});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(15000);          // 给足初始化时间
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000});
await page.waitForSelector('input[type=password]',{timeout:15000});
await page.waitForTimeout(1500);
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
await page.waitForTimeout(1500);

for(let i=1;i<=6;i++){
  if(!/password/.test(await page.locator('input[type=password]').count().then(n=>n?'password':'x'))){}
  resp=null;
  await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(async()=>{
    await page.locator('div.ds-button',{hasText:'登录'}).last().click({timeout:8000}).catch(()=>{});
  });
  for(let w=0;w<20 && !resp;w++) await page.waitForTimeout(500);
  const plain = await page.evaluate(()=>window.__plain||'');
  const dev = /"device_id":([^,]*)/.exec(plain)?.[1] ?? '?';
  console.log(`try${i}: resp=${resp?resp.status:'none'} device_id=${dev} url=${page.url()}`);
  if(!/sign_in/.test(page.url())) break;
  await page.waitForTimeout(3500);
}
const tok=await page.evaluate(()=>{try{return JSON.parse(localStorage.getItem('userToken')||'null')?.value||''}catch{return ''}});
console.log('FINAL URL:',page.url(),'TOKEN-LEN:',tok.length);
if(tok){const r=await page.evaluate(async t=>{const res=await fetch('/api/v0/users/current',{headers:{authorization:'Bearer '+t}});return res.status+' '+(await res.text()).slice(0,200)},tok);console.log('VERIFY:',r);}
await page.screenshot({path:'/root/opends-freetoken/data/artifacts/login/25-retry.png'});
await ctx.close();
