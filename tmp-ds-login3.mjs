import { chromium } from 'playwright';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
const shot=async(p,n)=>{await p.screenshot({path:`${OUT}/${n}.png`}).catch(()=>{});console.log('SHOT',n);};

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader','--no-first-run']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();
page.on('response', async r=>{
  const u=r.url(); if(!u.includes('/api/v0/')) return;
  const h=r.headers();
  const flags={}; for(const k of ['x-amzn-waf-action','cf-mitigated','x-ds-trace-id']) if(h[k]) flags[k]=h[k];
  let b=''; try{ b=(await r.text()).slice(0,300);}catch{}
  const interesting = r.status()!==200 || Object.keys(flags).length || /biz_code|challenge|captcha|400|risk/i.test(b);
  if(interesting) console.log('RESP', r.status(), r.request().method(), u.replace('https://chat.deepseek.com',''), JSON.stringify(flags), b.replace(/\s+/g,' ').slice(0,220));
});

await page.goto('https://chat.deepseek.com/sign_in',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3500);
await page.locator('span.ds-button__content', { hasText:'密码登录' }).first().click({timeout:8000});
await page.waitForTimeout(1200);
await shot(page,'08-pw-form');
console.log('INPUTS:', JSON.stringify(await page.locator('input').evaluateAll(e=>e.map(x=>({type:x.type,ph:x.placeholder})))));
console.log('TEXT:',(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,200));

const boxes = page.locator('input');
const n = await boxes.count();
if (n >= 2) {
  await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:50});
  await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:60});
} else { console.log('UNEXPECTED-INPUT-COUNT', n); }
await shot(page,'09-filled');
console.log('VALUES:', JSON.stringify(await boxes.evaluateAll(e=>e.map(x=>x.value))));

await page.locator('button', { hasText:'登录' }).first().click({timeout:8000}).catch(async()=>{
  await page.locator('div[role=button]', { hasText:'登录' }).first().click({timeout:8000}).catch(e=>console.log('submit?',e.message));
});
console.log('== submitted');
for (const [i,ms] of [[1,2500],[2,3000],[3,5000],[4,6000]]) { await page.waitForTimeout(ms); await shot(page,`10-after-submit-${i}`); }
console.log('URL:', page.url());
console.log('BODY:',(await page.locator('body').innerText()).replace(/\s+/g,' ').slice(0,600));
const st = await page.evaluate(()=>({token: localStorage.getItem('userToken'), smid: (localStorage.getItem('smidV2')||'').slice(0,24), did: localStorage.getItem('deepseek-device-id:chat'), tea: !!localStorage.getItem('__tea_cache_tokens_20006317')}));
console.log('STATE:', JSON.stringify(st));
await browser.close();
