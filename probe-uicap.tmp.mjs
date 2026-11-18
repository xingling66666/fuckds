import { loadConfig } from './src/config.mjs';
import { loadTokens } from './src/auth.mjs';
import { chromium } from 'playwright';
const config = loadConfig();
const token = loadTokens(config)[0];
const browser = await chromium.launch({ headless: false, args: ['--headless=new','--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width: 1440, height: 900 },
});
await ctx.addInitScript(`try{localStorage.setItem('userToken', JSON.stringify({value:${JSON.stringify(token)},__version:'0'}))}catch(e){}`);
const page = await ctx.newPage();
const caps = [];
page.on('request', (r) => {
  if (!r.url().includes('/api/v0/chat/')) return;
  let body = null;
  try { body = r.postData(); } catch {}
  caps.push({ url: r.url().replace('https://chat.deepseek.com',''), headers: r.headers(), body });
});
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForSelector('textarea, [contenteditable="true"]', { timeout: 60000 });
const input = page.locator('textarea, [contenteditable="true"]').first();
await input.click();
await input.type('只回复两个字：正常', { delay: 40 });
await page.keyboard.press('Enter');
await page.waitForTimeout(9000);

console.log('捕获数:', caps.length);
for (const c of caps) {
  console.log('---', c.url.slice(0, 60));
  if (c.body) {
    const b = JSON.parse(c.body);
    console.log('   body keys:', Object.keys(b).join(','));
    console.log('   shumei_device_id:', b.shumei_device_id ? String(b.shumei_device_id).slice(0,20)+'…' : '(无)');
  }
  const hs = Object.keys(c.headers).filter(h=>/hif|shumei|sec-ch|x-ds/.test(h));
  console.log('   特殊头:', hs.join(',') || '(无)');
}
await page.screenshot({ path: '/tmp/uicap.png' });
await browser.close();
