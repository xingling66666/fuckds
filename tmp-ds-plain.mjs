import { chromium } from 'playwright';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  // 抓加密前的明文
  const orig = crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt = async function(alg, key, data){
    try{ if (alg && alg.name === 'AES-CBC' && data) { window.__plain = new TextDecoder().decode(new Uint8Array(data)); } }catch(e){}
    return orig(alg, key, data);
  };
});
const page=await ctx.newPage();
page.on('response', async r=>{ if(r.url().includes('/api/v0/users/login')){ let b='';try{b=(await r.text()).slice(0,160)}catch{}; console.log('>> RESP', r.status(), b);} });

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(6000);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:8000});
await page.waitForSelector('input[type=password]',{timeout:15000});
await page.waitForTimeout(1000);
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
await page.waitForTimeout(1200);
await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000});
await page.waitForTimeout(6000);
const plain = await page.evaluate(()=>window.__plain||'(none)');
console.log('\n=== 加密前明文 ===');
console.log(plain.replace(/"password":"[^"]*"/,'"password":"***"'));
console.log('\nURL:', page.url());
await browser.close();
