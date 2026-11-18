import { loadConfig } from './src/config.mjs';
import { DeepSeekWeb } from './src/browser/driver.mjs';
const config = loadConfig();
const logs=[]; const logger={info(){},warn:(m)=>logs.push('W '+m),debug:(m,o)=>logs.push('D '+m+(o?JSON.stringify(o):'')),error:(m)=>logs.push('E '+m)};
const engine = new DeepSeekWeb({ config, logger });
try {
  await engine.warmUp?.().catch(()=>{});
  const t0=Date.now();
  const r = await engine.chat({ prompt: '\n## User\n只回复:ok', thinking:false, meta:{} });
  console.log('耗时:', Date.now()-t0,'ms | 文本:', JSON.stringify(r.text).slice(0,30), '| 轮次指标:', JSON.stringify({upstream:r.upstreamPromptChars, full:r.fullPromptChars}));
  console.log(logs.filter(l=>/浏览器证明|HIF/.test(l)).slice(-3).join('\n'));
} catch(e){ console.log('ERR', e.message.slice(0,160)); }
finally { try{await engine.close();}catch{} process.exit(0); }
