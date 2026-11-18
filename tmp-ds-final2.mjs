import { chromium } from 'playwright';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();

page.on('request', req=>{
  if(!req.url().includes('/api/v0/users/login')) return;
  const ct=req.headers()['content-type']||'';
  const ek=req.headers()['x-request-encryption-key']||'';
  const pd=req.postData()||'';
  console.log('\n>> LOGIN REQ  content-type:', ct);
  console.log('   x-request-encryption-key:', ek? ek.slice(0,24)+'... len='+ek.length : '(none)');
  console.log('   body:', ct.includes('json') ? pd.slice(0,300) : '<binary '+pd.length+' bytes>');
});
page.on('response', async r=>{
  if(!r.url().includes('/api/v0/users/login')) return;
  let b=''; try{b=(await r.text()).slice(0,300);}catch{}
  console.log('>> LOGIN RESP', r.status(), b);
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
// 等 device id 初始化
for(let i=0;i<40;i++){
  const did=await page.evaluate(()=>localStorage.getItem('deepseek-device-id:chat')).catch(()=>null);
  if(did){ console.log('DEVICE-ID ready:', did); break; }
  await page.waitForTimeout(500);
}
await page.waitForTimeout(1500);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000});
await page.waitForSelector('input[type=password]',{timeout:15000});
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:50});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:60});
await page.waitForTimeout(600);
await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000});
await page.waitForTimeout(9000);
console.log('URL:', page.url());
const tok=await page.evaluate(()=>{try{return JSON.parse(localStorage.getItem('userToken')||'null')?.value||''}catch{return ''}});
console.log('TOKEN-LEN:', tok.length);
if(tok){
  const r=await page.evaluate(async t=>{const res=await fetch('/api/v0/users/current',{headers:{authorization:'Bearer '+t}});return res.status+' '+(await res.text()).slice(0,220)},tok);
  console.log('VERIFY:', r);
}
await page.screenshot({path:`${OUT}/23-loggedin.png`});
console.log('SHOT 23');
await browser.close();
