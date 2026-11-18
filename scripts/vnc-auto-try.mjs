// 在 VNC(有头) 会话里自动过 hCaptcha：与人工同一环境
import { loadConfig } from '../src/config.mjs';
import { createEngine } from '../src/engine.mjs';
import { VncRegisterSession } from '../src/register/vnc-session.mjs';
import { makeAsk, loadCache } from '../src/captcha/a11y.mjs';

const logger = { info: (...a)=>console.log('[I]',...a), warn:(...a)=>console.log('[W]',...a), error:(...a)=>console.log('[E]',...a), debug:()=>{} };
const config = loadConfig(process.env, {});
const engine = createEngine({ config, logger });
const ask = makeAsk({ engine, cache: loadCache(), log: logger });
const s = new VncRegisterSession({ config, logger, ask });
const PROXY = process.argv[2] || 'http://127.0.0.1:7890';
const EMAIL = process.argv[3] || `kaiyang.luo1987+vn${Date.now().toString(36)}@gmail.com`;
await s.start({ email: EMAIL, password: process.env.DS_PW || 'Kq7-Vt2mXz9LpR4d', proxy: PROXY });
// DS_DUMP_HEADERS=1: 打印 /api/v0/users/* 的完整请求头（和人工注册的包做 diff）
if (process.env.DS_DUMP_HEADERS === '1' && s.page) {
  s.page.on('request', async (r) => {
    if (!/\/api\/v0\/users\//.test(r.url())) return;
    let h = {}; try { h = await r.allHeaders(); } catch {}
    console.log('[HDR]', r.method(), r.url().split('/api')[1], '| body', (r.postData() || '').length, 'bytes');
    for (const [k, v] of Object.entries(h)) console.log('   ', k + ':', String(v).slice(0, 100));
  });
}
// API-HOOK: 抓注册相关响应 + toast
if (s.page) {
  s.page.on('response', async (r) => {
    if (!/\/api\/v0\/users\//.test(r.url())) return;
    let b = ''; try { b = (await r.text()).slice(0, 300); } catch {}
    console.log('[API]', r.status(), r.url().split('/api')[1], '|', b);
  });
}
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  await new Promise(r => setTimeout(r, 3000));
  const st = s.status();
  console.log(`[state] ${st.state}${st.error ? ' err=' + st.error : ''}`);
  if (['done','failed'].includes(st.state)) break;
  if (st.state === 'waiting_code') {
    const txt = await s.page?.evaluate(() => document.body.innerText).catch(() => '');
    if (txt) console.log('[page]', String(txt).replace(/\n/g, ' | ').slice(0, 180));
  }
}
console.log('final:', JSON.stringify(s.status(), null, 1).slice(0, 600));
await s.stop().catch(()=>{});
process.exit(0);
