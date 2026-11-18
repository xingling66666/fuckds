import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseToolXmlCalls,
  findToolXmlBlocks,
  findToolXmlStart,
  buildToolXmlBlock,
} from '../src/prompt/toolxml.mjs';
import { parseToolCallsAny, findToolBlocksAny, findToolStartAny } from '../src/prompt/toolformat.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';
import { findToolMarkup } from '../src/openai/tool-text.mjs';

const XML = `先看一下
<____tool____>
<call name="bash">
<args>
<command>ls -la</command>
<timeout>10</timeout>
</args>
<description>列目录</description>
</call>
</____tool____>
看完了`;

const DSML = `<｜DSML｜calls>
<｜DSML｜invoke name="bash">
<｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

test('XML：解析出调用、参数做类型还原', () => {
  const calls = parseToolXmlCalls(XML, null, { includeDescription: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  const args = JSON.parse(calls[0].arguments);
  assert.deepEqual(args, { command: 'ls -la', timeout: 10 });
  assert.equal(typeof args.timeout, 'number');
  // 默认会把 <description> 并进参数，见后面的专门用例
  assert.ok(!('description' in args));
});

test('XML：多个 call 按顺序解析', () => {
  const two = `<____tool____>
<call name="a"><args><x>1</x></args></call>
<call name="b"><args><y>true</y></args></call>
</____tool____>`;
  const calls = parseToolXmlCalls(two);
  assert.deepEqual(calls.map((c) => c.name), ['a', 'b']);
  assert.deepEqual(JSON.parse(calls[1].arguments), { y: true });
});

test('XML：未闭合信封吞到结尾（流式截断）', () => {
  const truncated = '<____tool____>\n<call name="bash">\n<args>\n<command>ls';
  const blocks = findToolXmlBlocks(truncated);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].end, truncated.length);
});

test('XML：流式起点识别半截标签', () => {
  assert.deepEqual(findToolXmlStart('<____to'), { index: 0, complete: false });
  assert.deepEqual(findToolXmlStart('正文 <____tool____>'), { index: 3, complete: true });
  assert.equal(findToolXmlStart('普通正文，没有标签'), null);
});

test('重建：tool_calls → XML 块（与提示词教的形状一致）', () => {
  const block = buildToolXmlBlock([{ name: 'bash', input: { command: 'pwd', timeout: 5 } }]);
  assert.ok(block.startsWith('<____tool____>'));
  assert.ok(block.includes('<call name="bash">'));
  assert.ok(block.includes('<args>'));
  assert.ok(block.includes('<command>pwd</command>'));
  assert.ok(block.includes('<timeout>5</timeout>'));
  // 重建出来的块必须能被自己解析回来
  const back = parseToolXmlCalls(block);
  assert.deepEqual(JSON.parse(back[0].arguments), { command: 'pwd', timeout: 5 });
});

test('兜底：DSML 仍然能解析（历史残留）', () => {
  const calls = parseToolCallsAny(DSML);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
});

test('分发层：XML 优先 + DSML 兜底，两种块都能剔除', () => {
  assert.equal(findToolBlocksAny(XML).length, 1);
  assert.equal(findToolBlocksAny(DSML).length, 1);
  assert.equal(findToolBlocksAny(`${XML}\n${DSML}`).length, 2);
  const start = findToolStartAny(`${DSML} ${XML}`);
  assert.equal(start.index, 0);
});

test('parseToolCalls / findToolMarkup 走新格式', () => {
  const calls = parseToolCalls(XML);
  assert.equal(calls[0].name, 'bash');
  const marks = findToolMarkup(XML);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].kind, 'TOOL_CALL');
  const stripped =
    XML.slice(0, marks[0].start) + XML.slice(marks[0].end);
  assert.ok(!/____tool|<\/call>/.test(stripped), '块必须被整段剔除');
  assert.ok(stripped.includes('先看一下') && stripped.includes('看完了'));
});

/* ------------------------------------------------ <description> 的处理 */

const XML_DESC = '<____tool____><call name="bash"><args><command>ls</command></args><description>列目录</description></call></____tool____>';

test('description：默认并进 arguments（客户端常把它声明成必填参数）', () => {
  const [call] = parseToolXmlCalls(XML_DESC);
  assert.deepEqual(JSON.parse(call.arguments), { command: 'ls', description: '列目录' });
  assert.equal(call.description, '列目录');
});

test('description：includeDescription=false 时不进参数，但仍保留在 call.description', () => {
  const [call] = parseToolXmlCalls(XML_DESC, null, { includeDescription: false });
  assert.deepEqual(JSON.parse(call.arguments), { command: 'ls' });
  assert.equal(call.description, '列目录');
});

test('description：schema 没声明该参数时按声明裁掉（additionalProperties:false 才不会被拒）', async () => {
  const { getToolSchemas } = await import('../src/prompt/tools.mjs');
  const requiresIt = getToolSchemas([
    { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: {}, description: {} } } } },
  ]);
  const withoutIt = getToolSchemas([
    { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: { command: {} } } } },
  ]);
  const kept = parseToolCalls(XML_DESC, null, { toolSchemas: requiresIt })[0];
  const trimmed = parseToolCalls(XML_DESC, null, { toolSchemas: withoutIt })[0];
  assert.deepEqual(JSON.parse(kept.arguments), { command: 'ls', description: '列目录' });
  assert.deepEqual(JSON.parse(trimmed.arguments), { command: 'ls' });
});
