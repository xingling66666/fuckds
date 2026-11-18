import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT='/root/opends-freetoken/data/artifacts/login-now';
const CMD='/tmp/ds-click.txt';
const EMAIL='xingling66666+ds-test@gmail.com', PASS='clz646899';
try{fs.unlinkSync(CMD)}catch{}

const browser=await chromium.launch({headless:false,args:['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--use-gl=angle','--use-angle=swiftshader']});
const ctx=await browser.newContext({viewport:{width:1512,height:950},locale:'zh-CN',timezoneId:'Asia/Shanghai',
  userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'});
await ctx.addInitScript(()=>{
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  window.__plain=null;
  const oe=crypto.subtle.encrypt.bind(crypto.subtle);
  crypto.subtle.encrypt=async function(a,k,d){try{if(a&&a.name==='AES-CBC'&&d)window.__plain=new TextDecoder().decode(new Uint8Array(d));}catch{} return oe(a,k,d);};
});
const page=await ctx.newPage();
let lastLogin=null;
page.on('response', async r=>{ const p=r.url().replace('https://chat.deepseek.com','');
  if(/users\/(login|mfa\/|create_guest)/.test(p)){ let b='';try{b=(await r.text()).slice(0,300)}catch{}; lastLogin={s:r.status(),p,b}; console.log('NET', r.status(), p, b.replace(/\s+/g,' ').slice(0,220)); }
});

await page.goto('https://chat.deepseek.com/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(8000);
await page.locator('span.ds-button__content',{hasText:'密码登录'}).first().click({timeout:12000}).catch(()=>{});
await page.waitForSelector('input[type=password]',{timeout:20000});
const boxes=page.locator('input');
await boxes.nth(0).click(); await page.keyboard.type(EMAIL,{delay:55});
await boxes.nth(1).click(); await page.keyboard.type(PASS,{delay:65});
await page.waitForTimeout(2000);

// 反复提交直到 device_id 就绪（非 422）
for(let i=1;i<=4;i++){
  lastLogin=null;
  await page.getByRole('button',{name:'登录',exact:true}).first().click({timeout:8000}).catch(()=>{});
  for(let w=0;w<16 && !lastLogin;w++) await page.waitForTimeout(500);
  const plain = await page.evaluate(()=>window.__plain||'');
  const dev = /"device_id":([^,}]*)/.exec(plain)?.[1];
  console.log(`submit#${i}: resp=${lastLogin?lastLogin.s:'none'} device_id=${dev}`);
  if(lastLogin && lastLogin.s!==422) break;
  await page.waitForTimeout(3500);
}
console.log('MFA-MODAL:', /验证账号/.test(await page.locator('body').innerText()));
if(/验证账号/.test(await page.locator('body').innerText())){
  await page.getByText('发送验证码',{exact:true}).last().click({timeout:10000}).catch(e=>console.log('send fail',e.message.split('\n')[0]));
  await page.waitForTimeout(4000);
  await page.screenshot({path:`${OUT}/30-cap-0.png`});
  console.log('SHOT 30-cap-0 (等待坐标)');
  for(let round=1; round<=4; round++){
    let cmd=null, waited=0;
    while(waited<150000){ if(fs.existsSync(CMD)){cmd=fs.readFileSync(CMD,'utf8').trim();fs.unlinkSync(CMD);break;} await page.waitForTimeout(400); waited+=400; }
    if(!cmd){ console.log('NO-CMD-TIMEOUT'); break; }
    const [x,y]=cmd.split(',').map(Number);
    console.log(`ROUND${round} click abs(${x},${y})`);
    await page.mouse.move(x-60,y-45); await page.waitForTimeout(90);
    await page.mouse.move(x-18,y-12); await page.waitForTimeout(70);
    await page.mouse.click(x,y);
    await page.waitForTimeout(3000);
    await page.screenshot({path:`${OUT}/31-cap-after-${round}.png`});
    console.log('SHOT 31-cap-after-'+round);
    const t=(await page.locator('body').innerText()).replace(/\s+/g,' ');
    console.log('TEXT:', t.slice(-180));
    if(!/三棱柱|图中|点击/.test(t)) { console.log('>>> 验证码可能已过'); break; }
  }
}
await page.screenshot({path:`${OUT}/32-state.png`});
console.log('KEEP-OPEN 4min');
await page.waitForTimeout(240000);
await browser.close();
