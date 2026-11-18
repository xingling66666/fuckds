import { chromium } from 'playwright';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const mask = (v='') => v.length > 18 ? v.slice(0,10)+'…'+v.slice(-6) : v;

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();

// 登录
await page.goto('https://chat.deepseek.com/sign_in',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3000);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000});
await page.waitForTimeout(800);
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:45});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:55});
await page.locator('button',{hasText:'登录'}).first().click({timeout:8000});
await page.waitForTimeout(6000);
console.log('LOGGED-IN URL:', page.url());

// 监听 completion 请求头
let captured=false;
page.on('request', async req => {
  const u=req.url();
  if (!u.includes('/api/v0/chat/completion') || captured) return;
  captured=true;
  const hdrs = req.headersArray();
  console.log('\n===== COMPLETION REQUEST HEADERS (wire order) =====');
  for (const h of hdrs) {
    const isSecret = /authorization|x-ds-pow-response|x-settings-token/i.test(h.name);
    console.log(`${h.name}: ${isSecret ? mask(h.value)+' ('+h.value.length+')' : h.value}`);
  }
  console.log('BODY:', (req.postData()||'').slice(0,400));
});
page.on('response', async r=>{
  const u=r.url();
  if (u.includes('/api/v0/chat/completion')) {
    console.log('\n===== COMPLETION RESPONSE', r.status(), '=====');
    console.log('CT:', r.headers()['content-type']);
    try { const t = await r.text(); console.log(t.split('\n').slice(0,6).join('\n').slice(0,500)); } catch(e){ console.log('body err', e.message); }
  }
});

// 真输入
await page.waitForSelector('textarea', { timeout: 20000 });
await page.locator('textarea').first().click();
await page.keyboard.type('你好，用一句话介绍一下你自己', { delay: 70 });
await page.waitForTimeout(600 + Math.random()*500);
await page.keyboard.press('Enter');
console.log('== sent');
await page.waitForTimeout(12000);
await page.screenshot({ path: `${OUT}/11-chat-reply.png` });
console.log('SHOT 11-chat-reply');
const txt = (await page.locator('body').innerText()).replace(/\s+/g,' ');
console.log('PAGE-TEXT-TAIL:', txt.slice(-500));
const st = await page.evaluate(()=>({hif: Object.keys(localStorage).filter(k=>k.startsWith('hif_')).map(k=>k+'='+localStorage.getItem(k).slice(0,20)), tea:!!localStorage.getItem('__tea_cache_tokens_20006317')}));
console.log('STATE:', JSON.stringify(st));
await ctx.storageState({ path: '/root/opends-freetoken/data/artifacts/login/state.json' });
console.log('SAVED state.json');
await browser.close();
