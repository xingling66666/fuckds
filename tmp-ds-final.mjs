import { chromium } from 'playwright';
const OUT='/root/opends-freetoken/data/artifacts/login';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader','--no-first-run']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();

const loginResp=[];
page.on('response', async r=>{
  if (r.url().includes('/api/v0/users/login')) {
    let b=''; try{b=(await r.text()).slice(0,260);}catch{}
    loginResp.push({status:r.status(), body:b});
  }
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(4000);
console.log('URL0:', page.url());

// 切密码登录（这个页面渲染的是带 <button> 的版本）
await page.getByText('密码登录',{exact:true}).first().click({timeout:6000}).catch(async()=>{
  await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:6000}).catch(e=>console.log('toggle fail',e.message));
});
await page.waitForSelector('input[type=password]',{timeout:15000});
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:50});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:60});
await page.waitForTimeout(300);
console.log('BTN-COUNT:', await page.locator('button').count());
await page.getByRole("button",{name:"登录",exact:true}).first().click({timeout:8000}).catch(async()=>{
  await page.locator('div.ds-button',{hasText:'登录'}).last().click({timeout:8000}).catch(e=>console.log('submit fail',e.message));
});
await page.waitForTimeout(9000);
console.log('LOGIN-RESP:', JSON.stringify(loginResp).slice(0,600));
console.log('URL1:', page.url());

const st=await page.evaluate(()=>{try{const t=JSON.parse(localStorage.getItem('userToken')||'null');return{token:t?.value||'', user:localStorage.getItem('__appKit_userInfo')?.slice(0,120), smid:(localStorage.getItem('smidV2')||'').slice(0,22), did:localStorage.getItem('deepseek-device-id:chat'), tea:!!localStorage.getItem('__tea_cache_tokens_20006317')};}catch{return{}}});
console.log('TOKEN-LEN:', (st.token||'').length, 'DID:', st.did, 'SMID:', st.smid, 'TEA:', st.tea);
if (st.token) {
  const r=await page.evaluate(async t=>{const res=await fetch('/api/v0/users/current',{headers:{authorization:'Bearer '+t}});return{status:res.status,body:(await res.text()).slice(0,300)};}, st.token);
  console.log('VERIFY /users/current:', r.status, r.body);
  const r2=await page.evaluate(async t=>{const res=await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false&count=3',{headers:{authorization:'Bearer '+t}});return{status:res.status,body:(await res.text()).slice(0,300)};}, st.token);
  console.log('VERIFY /chat_session/fetch_page:', r2.status, r2.body);
}
await page.screenshot({path:`${OUT}/22-logged-in.png`});
console.log('SHOT 22-logged-in');
await ctx.storageState({path:`${OUT}/storage-state.json`});
console.log('SAVED storage-state.json');
await browser.close();
