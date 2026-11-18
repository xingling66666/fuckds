import { loadConfig } from './src/config.mjs';
import { DeepSeekWeb } from './src/browser/driver.mjs';
const config = loadConfig();
const logs = [];
const logger = { info: (m, o) => logs.push(['info', m, o]), warn: (m, o) => logs.push(['warn', m, o]), debug: (m, o) => logs.push(['debug', m, o]), error: (m, o) => logs.push(['error', m, o]) };
const engine = new DeepSeekWeb({ config, logger });
try {
  await engine.warmUp?.().catch(() => {});
  const t0 = Date.now();
  const r = await engine.chat({ prompt: '\n## User\n只回复两个字：正常', thinking: false, meta: {} });
  console.log('耗时:', Date.now() - t0, 'ms | 文本:', JSON.stringify(r.text).slice(0, 40));
  console.log('--- 日志 ---');
  for (const [l, m, o] of logs.slice(-14)) {
    if (/浏览器证明|续聊|耗时|错误|warn/i.test(String(m))) console.log(l, String(m).slice(0, 160), o ? JSON.stringify(o).slice(0, 120) : '');
  }
} catch (e) {
  console.log('ERR', e.message.slice(0, 200));
} finally { try { await engine.close(); } catch {} process.exit(0); }
