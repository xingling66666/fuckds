import { chromium } from 'playwright';
import fs from 'node:fs';
import { loadConfig } from './src/config.mjs';
import { loadProfile } from './src/profile.mjs';
const cfg = loadConfig({}, { store: false });
const token='00U/1Nyu/gZ9WZYzZE2cch1foQnjvUBmHASHJK2mmMEsW2BDd2/9LFq4KWYrXPdR';
const profile = loadProfile(cfg.dataDir, token);
console.log('档案 storage 键数:', Object.keys(profile?.storage||{}).length, '| device:', profile?.deviceId);
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const b=await chromium.launch({ headless:false, args:['--headless=new'] });
const ctx=await b.newContext({ userAgent:UA, locale:'zh-CN', timezoneId:'Asia/Shanghai' });
await ctx.addInitScript((storage)=>{
  try{ if(/deepseek\.com$/.test(location.hostname)) for(const [k,v] of Object.entries(storage||{})) localStorage.setItem(k,v); }catch(e){}
}, profile.storage);
const p=await ctx.newPage();
const calls=[];
p.on('response', async (r)=>{ if(r.url().includes('/api/v0/')){ let t=''; try{t=(await r.text()).slice(0,120)}catch{}; calls.push(`${r.status()} ${r.request().method()} ${r.url().replace('https://chat.deepseek.com','')} → ${t.replace(/\s+/g,' ')}`); } });
await p.goto('https://chat.deepseek.com/', { waitUntil:'domcontentloaded', timeout:60000 });
await p.waitForTimeout(6000);
console.log('URL:', p.url());
console.log('注入后 localStorage userToken 存在:', await p.evaluate(()=>Boolean(localStorage.getItem('userToken'))));
console.log('=== 页内 /api/v0 调用 ===');
for (const c of calls.slice(0,8)) console.log(' ', c.slice(0,180));
await b.close().catch(()=>{});
