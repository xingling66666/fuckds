import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='/root/opends-freetoken/data/artifacts/login-now';
const CMD='/tmp/ds-click.txt';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
try{fs.unlinkSync(CMD)}catch{}

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>Object.defineProperty(navigator,'webdriver',{get:()=>undefined}));
const page=await ctx.newPage();
const net=[];
page.on('response', async r=>{ const p=r.url().replace('https://chat.deepseek.com','');
  if(!/api\/v0\/users\/(login|mfa|create_guest)/.test(p)) return;
  let b=''; try{b=(await r.text()).slice(0,400)}catch{}
  net.push(`${r.status()} ${p} :: ${b.replace(/\s+/g,' ')}`); console.log('NET', r.status(), p, b.slice(0,160));
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(7000);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:10000}).catch(()=>{});
await page.waitForSelector('input[type=password]',{timeout:15000});
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
await page.waitForTimeout(1500);
await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(()=>{});
await page.waitForTimeout(6000);
console.log('AT MFA:', /验证账号/.test(await page.locator('body').innerText()));

await page.getByText('发送验证码',{exact:true}).last().click({timeout:8000}).catch(e=>console.log('send click fail',e.message.split('\n')[0]));
await page.waitForTimeout(3500);

// 找验证码容器
async function findBox(){
  const cands = await page.evaluate(()=>{
    const out=[];
    const push=(el,kind)=>{ const r=el.getBoundingClientRect(); if(r.width>150&&r.height>120) out.push({kind, x:r.x,y:r.y,w:r.width,h:r.height, cls:(el.className||'').toString().slice(0,40), id:el.id||''}); };
    document.querySelectorAll('iframe').forEach(f=>push(f,'iframe'));
    document.querySelectorAll('div,section').forEach(d=>{ const c=(d.className||'').toString(); if(/captcha|shumei|verify|challenge/i.test(c)) push(d,'div'); });
    return out;
  });
  return cands[0]||null;
}
let box = await findBox();
console.log('CAPTCHA BOX:', JSON.stringify(box));
if(box){
  await page.screenshot({path:`${OUT}/20-captcha-full.png`});
  await page.screenshot({path:`${OUT}/20-captcha-crop.png`, clip:{x:box.x,y:box.y,width:box.w,height:box.h}});
  console.log('SHOT 20-captcha-crop');
}

// 等待外部点击指令
for(let round=1; round<=4; round++){
  console.log('WAITING-CLICK round',round);
  let cmd=null, waited=0;
  while(waited<120000){ if(fs.existsSync(CMD)){ cmd=fs.readFileSync(CMD,'utf8').trim(); fs.unlinkSync(CMD); break; } await page.waitForTimeout(500); waited+=500; }
  if(!cmd){ console.log('NO-CLICK-TIMEOUT'); break; }
  const [rx,ry]=cmd.split(',').map(Number);
  box = await findBox();
  if(!box){ console.log('BOX-GONE'); break; }
  const x=box.x+rx, y=box.y+ry;
  console.log(`CLICK round${round} at rel(${rx},${ry}) -> abs(${Math.round(x)},${Math.round(y)})`);
  // 人类式移动
  await page.mouse.move(x-40,y-30); await page.waitForTimeout(80);
  await page.mouse.move(x-10,y-8);  await page.waitForTimeout(60);
  await page.mouse.click(x,y);
  await page.waitForTimeout(2500);
  await page.screenshot({path:`${OUT}/21-after-click-${round}.png`});
  const b2 = await findBox();
  console.log('BOX-AFTER:', JSON.stringify(b2));
  if(b2){ await page.screenshot({path:`${OUT}/21-crop-${round}.png`, clip:{x:b2.x,y:b2.y,width:b2.w,height:b2.h}}); console.log('SHOT 21-crop',round); }
  else console.log('CAPTCHA GONE (可能已过)');
  const t=(await page.locator('body').innerText()).replace(/\s+/g,' ');
  console.log('TEXT:', t.slice(-200));
  if(/验证并登录|已发送|重新发送|秒后/.test(t)) console.log('>>> 状态变化，可能已发送');
}
console.log('\n===== NET SUMMARY =====');
for(const n of net) console.log(n);
await page.screenshot({path:`${OUT}/22-final.png`});
console.log('KEEPING BROWSER OPEN 5min');
await page.waitForTimeout(300000);
await browser.close();
