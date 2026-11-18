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
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

const out = await page.evaluate(async () => {
  const load = () => new Promise((res) => {
    if (window.SMSdk) return res(true);
    const s = document.createElement('script');
    s.src = '/static/fp.min.js'; s.dataset.fp = 'true';
    s.onload = () => res(true); s.onerror = () => res(false);
    document.head.appendChild(s);
    setTimeout(() => res(Boolean(window.SMSdk)), 15000);
  });
  await load();
  if (!window.SMSdk) return { error: 'SMSdk 未加载' };
  const tryGet = () => { try { return window.SMSdk.getDeviceId?.() || ''; } catch { return ''; } };
  let id = tryGet();
  if (!id) {
    // 触发一次设备档案生成
    try { window.SMSdk.createDeviceId?.(); } catch {}
    try { window.SMSdk.ready?.(() => {}); } catch {}
    for (let i = 0; i < 30 && !id; i++) { await new Promise((r) => setTimeout(r, 500)); id = tryGet(); }
  }
  return { id, sdkKeys: Object.keys(window.SMSdk || {}).slice(0, 12) };
});
console.log('getDeviceId 结果:', JSON.stringify(out));
await browser.close();
