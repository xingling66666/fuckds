import { loadConfig } from './src/config.mjs';
import { DeepSeekWeb } from './src/browser/driver.mjs';
const config = loadConfig({}, { store: false });
config.deepseek.token = '0dH9va8n46uiovqDS8bwrOLlD08mzO1hy1WibiKhRIqrJwhGtXr9aKwgZOBjdF1d';
config.deepseek.deviceId = '2d70ce31-d4ff-43f6-b7c2-51e857867812';
const logs=[]; const logger={info:(m,o)=>logs.push('I '+m),warn:(m)=>logs.push('W '+m),error:(m)=>logs.push('E '+m),debug:(m)=>logs.push('D '+(typeof m==='string'?m:''))};
const engine = new DeepSeekWeb({ config, logger });
try {
  const t0=Date.now();
  const r = await engine.chat({ prompt:'\n## User\n只回复:ok', thinking:false, meta:{} });
  console.log('✅ 耗时', Date.now()-t0,'ms | text:', JSON.stringify(r.text).slice(0,40));
} catch(e) { console.log('ERR:', e.message.slice(0,120)); }
finally { console.log(logs.filter(l=>/证明|续聊|Qwen|token/i.test(l)).slice(-3).join(' | ').slice(0,300)); await engine.close().catch(()=>{}); process.exit(0); }
