import { chromium } from 'playwright';
const PROF='/root/opends-freetoken/data/artifacts/pw-profile';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const mask=v=>v&&v.length>18?v.slice(0,10)+'…'+v.slice(-6):v;

const ctx=await chromium.launchPersistentContext(PROF,{headless:false,viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=ctx.pages()[0]??await ctx.newPage();

await page.goto('https://chat.deepseek.com/sign_in',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3500);
if (/sign_in/.test(page.url())) {
  await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000});
  await page.waitForSelector('input[type=password]',{timeout:15000});
  const boxes=page.locator('input');
  await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:50});
  await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:60});
  await page.waitForTimeout(400);
  await page.locator('div.ds-button',{hasText:'登录'}).last().click({timeout:10000});
  console.log('== submit clicked');
  await page.waitForTimeout(7000);
}
console.log('URL:', page.url());
await page.screenshot({path:`${OUT}/16-home.png`});
const li = await page.evaluate(()=>({token:!!localStorage.getItem('userToken'), did:localStorage.getItem('deepseek-device-id:chat')}));
console.log('STATE:', JSON.stringify(li));

let done=false;
page.on('request', req=>{
  if(!req.url().includes('/api/v0/chat/completion')||done)return; done=true;
  console.log('\n===== COMPLETION HEADERS (wire order) =====');
  for(const h of req.headersArray()){
    const sec=/authorization|x-ds-pow-response|x-settings-token/i.test(h.name);
    console.log(`${h.name}: ${sec?mask(h.value)+'  [len '+h.value.length+']':h.value}`);
  }
  console.log('BODY:',(req.postData()||'').slice(0,350));
});
page.on('response',async r=>{
  if(!r.url().includes('/api/v0/chat/completion'))return;
  console.log('\n===== COMPLETION RESPONSE',r.status(),'=====');
  try{const t=await r.text();console.log(t.split('\n').slice(0,8).join('\n').slice(0,700));}catch(e){console.log('err',e.message);}
});

await page.waitForSelector('textarea',{timeout:25000});
await page.locator('textarea').first().click();
await page.keyboard.type('你好，用一句话介绍你自己',{delay:65});
await page.waitForTimeout(800+Math.random()*600);
await page.keyboard.press('Enter');
console.log('== sent');
await page.waitForTimeout(15000);
await page.screenshot({path:`${OUT}/17-reply.png`});
console.log('SHOT 17-reply');
console.log('TAIL:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(-350));
console.log('HIF-KEYS:', JSON.stringify(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('hif_')).map(k=>[k,localStorage.getItem(k).slice(0,14)]))));
await ctx.close();
