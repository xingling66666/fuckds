import { loadConfig } from './src/config.mjs';
import { DeepSeekWeb } from './src/browser/driver.mjs';
const config = loadConfig({}, { store: false });
const logs=[]; const logger={info:(m)=>logs.push('I '+m),warn:(m)=>logs.push('W '+m),error:(m)=>logs.push('E '+m),debug:(m,o)=>logs.push('D '+(typeof m==='string'?m:''))};
const engine = new DeepSeekWeb({ config, logger });
try {
  const r = await engine.chat({ prompt: '\n## User\n今天郑州天气怎么样？请联网查一下', thinking: false, search: true, meta: {} });
  console.log('耗时/长度:', r.elapsedMs, 'ms | text', (r.text||'').length, '字');
  console.log('正文前 200:', JSON.stringify(r.text||'').slice(0,200));
  console.log('reasoning 长度:', (r.reasoning||'').length);
  console.log('返回对象键:', Object.keys(r).join(','));
  console.log('usage/refs:', JSON.stringify({usage:r.usage, refs:r.references||null, searchTriggered:r.searchTriggered}).slice(0,300));
} catch(e) { console.log('ERR:', e.message.slice(0,160)); }
finally { console.log(logs.filter(l=>/搜索|search|证明/i.test(l)).slice(-4).join(' | ').slice(0,300)); await engine.close().catch(()=>{}); process.exit(0); }
