import { parseToolCallsAny, findToolBlocksAny, findToolStartAny, buildToolCallBlock } from '../src/prompt/toolformat.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';
import { findToolMarkup } from '../src/openai/tool-text.mjs';

const xmlSample = `先看一下目录
<____tool____>
<call name="bash">
<args>
<command>ls -la</command>
<timeout>10</timeout>
</args>
<description>查看当前目录</description>
</call>
<call name="think">
<args>
<text>要不要加 -h</text>
</args>
</call>
</____tool____>
看完了`;

const dsmlSample = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

console.log('1) XML 解析:', JSON.stringify(parseToolCallsAny(xmlSample), null, 1));
console.log('2) DSML 兜底:', JSON.stringify(parseToolCallsAny(dsmlSample)));
console.log('3) 块剔除:', findToolBlocksAny(xmlSample).length, '个块,', '剔除后正文:',
  JSON.stringify(xmlSample.replace(/[\s\S]*?(?=先看)/,'').split('\n')[0]));
const blocks = findToolBlocksAny(xmlSample);
let kept = '', cursor = 0;
for (const b of blocks) { kept += xmlSample.slice(cursor, b.start); cursor = Math.max(cursor, b.end); }
kept += xmlSample.slice(cursor);
console.log('   剔除后 content =', JSON.stringify(kept));
console.log('4) 重建:', JSON.stringify(buildToolCallBlock([{ name: 'bash', input: { command: 'ls -la', timeout: 10 } }])));
console.log('5) 流式起点:', JSON.stringify(findToolStartAny('<____to')), JSON.stringify(findToolStartAny('普通正文 <____tool____>')));
console.log('6) parseToolCalls(带兜底):', JSON.stringify(parseToolCalls(xmlSample).map(c => ({ n: c.name, a: c.arguments }))));
console.log('7) findToolMarkup:', JSON.stringify(findToolMarkup(xmlSample).map(b => [b.kind, b.start, b.end])));
