import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('/root/opends-freetoken/data/artifacts/pw-profile', {
  headless:false, viewport:{width:1512,height:950}, locale:'zh-CN', timezoneId:'Asia/Shanghai',
  args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto('https://chat.deepseek.com/sign_in',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(3500);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000}).catch(e=>console.log('toggle',e.message));
await page.waitForSelector('input[type=password]',{timeout:15000});
await page.waitForTimeout(500);
const info = await page.evaluate(()=>{
  const out=[];
  document.querySelectorAll('*').forEach(el=>{
    const t=(el.textContent||'').trim();
    if(t==='登录' && el.children.length===0){
      const r=el.getBoundingClientRect();
      out.push({tag:el.tagName, cls:(el.className||'').slice(0,50), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)],
                pTag:el.parentElement?.tagName, pCls:(el.parentElement?.className||'').slice(0,50), gpTag:el.parentElement?.parentElement?.tagName, gpCls:(el.parentElement?.parentElement?.className||'').slice(0,40)});
    }
  });
  return {out, buttons: document.querySelectorAll('button').length, divs: document.querySelectorAll('div[role=button]').length};
});
console.log(JSON.stringify(info,null,1));
await page.screenshot({path:'/root/opends-freetoken/data/artifacts/login/15-form.png'});
await ctx.close();
