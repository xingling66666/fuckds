import { chromium } from 'playwright';
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const browser=await chromium.launch({headless:true,args:['--disable-blink-features=AutomationControlled']});
const ctx=await browser.newContext({userAgent:UA,locale:'zh-CN',timezoneId:'Asia/Shanghai',viewport:{width:1440,height:900}});
await ctx.addInitScript(`try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});if(!window.chrome)window.chrome={runtime:{}}}catch(e){}`);
const page=await ctx.newPage();
const seen=[];
page.on('request', (r)=>{
  const u=r.url();
  if(u.includes('/api/v0/')) seen.push({url:u.replace('https://chat.deepseek.com',''), method:r.method(), headers:r.headers(), body:r.postData()});
});
await page.goto('https://chat.deepseek.com/', {waitUntil:'domcontentloaded', timeout:60000});
await page.waitForTimeout(6000);
console.log('捕获请求数:', seen.length);
for (const s of seen.slice(0,3)) {
  console.log('\n===', s.method, s.url, '===');
  console.log(JSON.stringify(s.headers, null, 1));
}
await browser.close();
