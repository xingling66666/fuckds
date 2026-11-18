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

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(4000);
console.log('URL0:', page.url());

if (/sign_in/.test(page.url())) {
  let pwCount = await page.locator('input[type=password]').count();
  if (!pwCount) {
    const toggle = page.locator('span.ds-button__content',{hasText:'密码登录'}).first();
    if (await toggle.count()) { await toggle.click({timeout:8000}).catch(e=>console.log('toggle',e.message)); await page.waitForTimeout(1200); }
  }
  pwCount = await page.locator('input[type=password]').count();
  console.log('password-inputs:', pwCount);
  await page.screenshot({path:`${OUT}/18-form.png`});
  if (pwCount) {
    const boxes=page.locator('input');
    await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:50});
    await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:60});
    await page.waitForTimeout(400);
    const submit = page.locator('div.ds-button',{hasText:'登录'}).last();
    console.log('submit-count:', await submit.count());
    await submit.click({timeout:10000});
    console.log('== submit clicked');
    await page.waitForTimeout(8000);
  }
}
console.log('URL1:', page.url());
await page.screenshot({path:`${OUT}/19-after-login.png`});
console.log('TOKEN?', await page.evaluate(()=>!!localStorage.getItem('userToken')));

let done=false;
page.on('request', req=>{
  if(!req.url().includes('/api/v0/chat/completion')||done)return; done=true;
  console.log('\n===== COMPLETION HEADERS =====');
  for(const h of req.headersArray()){
    const sec=/authorization|x-ds-pow-response|x-settings-token/i.test(h.name);
    console.log(`${h.name}: ${sec?mask(h.value)+'  [len '+h.value.length+']':h.value}`);
  }
  console.log('BODY:',(req.postData()||'').slice(0,300));
});
page.on('response',async r=>{
  if(!r.url().includes('/api/v0/chat/completion'))return;
  console.log('\n===== COMPLETION RESPONSE',r.status(),'=====');
  try{const t=await r.text();console.log(t.split('\n').slice(0,6).join('\n').slice(0,600));}catch(e){console.log('err',e.message);}
});

if (!/sign_in/.test(page.url())) {
  await page.waitForSelector('textarea',{timeout:25000});
  await page.locator('textarea').first().click();
  await page.keyboard.type('你好，用一句话介绍你自己',{delay:65});
  await page.waitForTimeout(800+Math.random()*600);
  await page.keyboard.press('Enter');
  console.log('== sent');
  await page.waitForTimeout(15000);
  await page.screenshot({path:`${OUT}/20-reply.png`});
  console.log('TAIL:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(-300));
}
await ctx.close();
