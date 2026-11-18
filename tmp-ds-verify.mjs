import { chromium } from 'playwright';
const ctx=await chromium.launchPersistentContext('/root/opends-freetoken/data/artifacts/pw-profile',{headless:false,viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled']});
const page=ctx.pages()[0]??await ctx.newPage();
await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(5000);
const url=page.url();
const st=await page.evaluate(()=>{try{const t=JSON.parse(localStorage.getItem('userToken')||'null');return {raw:localStorage.getItem('userToken'),value:t?.value,did:localStorage.getItem('deepseek-device-id:chat')};}catch{return{}}});
console.log('URL:',url);
console.log('TOKEN-LEN:', st.value?st.value.length:0, ' DID:', st.did);
if (st.value) {
  const r = await page.evaluate(async (tok) => {
    const res = await fetch('/api/v0/users/current', { headers: { authorization: 'Bearer '+tok } });
    return { status: res.status, body: (await res.text()).slice(0,400) };
  }, st.value);
  console.log('USERS/CURRENT:', r.status, r.body);
}
await page.screenshot({path:'/root/opends-freetoken/data/artifacts/login/21-verify.png'});
await ctx.close();
