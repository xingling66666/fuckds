import { chromium } from 'playwright';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();
let lastStatus=0, lastBody='';
page.on('response', async r=>{ if(r.url().includes('/api/v0/users/login')){ lastStatus=r.status(); try{lastBody=(await r.text()).slice(0,200);}catch{} console.log('>> LOGIN RESP', lastStatus, lastBody);} });

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(6000);                       // 让 device/埋点/数美 全部初始化
await page.mouse.move(700,400); await page.mouse.move(760,430); await page.waitForTimeout(800);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000});
await page.waitForSelector('input[type=password]',{timeout:15000});
await page.waitForTimeout(1200);
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:60});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:70});
await page.waitForTimeout(1500);

for (let attempt=1; attempt<=3; attempt++) {
  lastStatus=0;
  await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000});
  await page.waitForTimeout(5000);
  console.log(`attempt ${attempt}: status=${lastStatus} url=${page.url()}`);
  if (!/sign_in/.test(page.url())) break;
  if (lastStatus===422) { await page.waitForTimeout(3000); continue; }   // device_id 未就绪，稍等再试
  break;
}
const tok=await page.evaluate(()=>{try{return JSON.parse(localStorage.getItem('userToken')||'null')?.value||''}catch{return ''}});
console.log('URL:', page.url(), 'TOKEN-LEN:', tok.length);
if(tok){ const r=await page.evaluate(async t=>{const res=await fetch('/api/v0/users/current',{headers:{authorization:'Bearer '+t}});return res.status+' '+(await res.text()).slice(0,240)},tok); console.log('VERIFY:', r); }
await page.screenshot({path:`${OUT}/24-final.png`});
console.log('SHOT 24');
await browser.close();
