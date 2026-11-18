import { chromium } from 'playwright';
const PROF='/root/opends-freetoken/data/artifacts/pw-profile';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const mask=v=>v&&v.length>18?v.slice(0,10)+'…'+v.slice(-6):v;

const ctx = await chromium.launchPersistentContext(PROF, {
  headless:false,
  viewport:{width:1512,height:950},
  locale:'zh-CN', timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader','--no-first-run','--no-default-browser-check'],
});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page = ctx.pages()[0] ?? await ctx.newPage();

await page.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await page.waitForTimeout(4000);
console.log('START URL:', page.url());

const loggedIn = async () => !/\/sign_in/.test(page.url());
if (!(await loggedIn())) {
  console.log('=> need login');
  await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000});
  await page.waitForSelector('input[type=password]', { timeout:15000 });
  const boxes = page.locator('input');
  console.log('INPUTS:', JSON.stringify(await boxes.evaluateAll(e=>e.map(x=>x.type))));
  await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:45});
  await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:55});
  await page.screenshot({path:`${OUT}/12-filled.png`});
  const btns = await page.locator('button').evaluateAll(els=>els.map((e,i)=>({i, t:(e.textContent||'').trim().slice(0,20), cls:(e.className||'').slice(0,30), disabled:e.disabled})));
  console.log('BUTTONS:', JSON.stringify(btns.slice(-8)));
  await page.keyboard.press('Enter');            // 表单回车提交
  await page.waitForTimeout(2500);
  if (/\/sign_in/.test(page.url())) {
    for (const b of await page.locator('button').all()) {
      const t=(await b.innerText().catch(()=>''))||'';
      if (t.trim()==='登录') { await b.click({timeout:5000}).catch(e=>console.log('btn click', e.message)); break; }
    }
  }
  await page.waitForTimeout(6000);
  console.log('AFTER LOGIN URL:', page.url());
}
await page.screenshot({path:`${OUT}/13-home.png`});
console.log('SHOT 13-home');

// 抓 completion 头
let done=false;
page.on('request', req=>{
  if(!req.url().includes('/api/v0/chat/completion')||done) return; done=true;
  console.log('\n===== COMPLETION REQUEST HEADERS =====');
  for(const h of req.headersArray()){
    const sec=/authorization|x-ds-pow-response|x-settings-token/i.test(h.name);
    console.log(`${h.name}: ${sec?mask(h.value)+' len='+h.value.length : h.value}`);
  }
  console.log('BODY:', (req.postData()||'').slice(0,300));
});
page.on('response', async r=>{
  if(!r.url().includes('/api/v0/chat/completion')) return;
  console.log('\n===== COMPLETION RESPONSE', r.status(), '=====');
  try{ const t=await r.text(); console.log(t.split('\n').slice(0,8).join('\n').slice(0,600)); }catch(e){ console.log('err',e.message); }
});

await page.waitForSelector('textarea',{timeout:20000});
await page.locator('textarea').first().click();
await page.keyboard.type('你好，请用一句话自我介绍',{delay:65});
await page.waitForTimeout(700+Math.random()*500);
await page.keyboard.press('Enter');
console.log('== sent');
await page.waitForTimeout(14000);
await page.screenshot({path:`${OUT}/14-reply.png`});
console.log('SHOT 14-reply');
console.log('TEXT-TAIL:', (await page.locator('body').innerText()).replace(/\s+/g,' ').slice(-400));
console.log('HIF:', JSON.stringify(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.startsWith('hif_')).map(k=>[k, localStorage.getItem(k).slice(0,16)]))));
await ctx.close();
