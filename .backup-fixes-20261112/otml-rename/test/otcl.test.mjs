import test from 'node:test';
import assert from 'node:assert/strict';

import { findOtclBlocks, parseOtclCalls, OtclBlockStreamFilter } from '../src/prompt/otcl.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';
import { findToolMarkup, stripToolMarkup } from '../src/openai/tool-text.mjs';

const wrap = (body) => '```otcl\n' + body + '\n```';

/* ---------------------------------------------------------------- 块解析 */

test('otcl: 只有 ```otcl 围栏块内的内容才算工具调用', () => {
  const text = `先说明一下。\n${wrap('exec_shell({command:"uname -a", timeout:10});')}\n完成。`;
  const calls = parseOtclCalls(text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'exec_shell');
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a', timeout: 10 });
  assert.equal(calls[0].index, text.indexOf('exec_shell'));
});

test('otcl: 围栏外的普通 JS 代码 / 普通 ```js 代码块不会被当成工具调用', () => {
  const text = [
    '用户要的代码：',
    'const x = app.get({path:"/"});',
    'exec_shell({command:"ls"});',
    'console.log(x);',
    '```js',
    'exec_shell({command:"evil"});',
    '```',
  ].join('\n');
  assert.deepEqual(parseOtclCalls(text), []);
  assert.deepEqual(parseToolCalls(text, ['exec_shell']), []);
  // 内容原样保留，不能把代码删掉
  assert.equal(stripToolMarkup(text, ['exec_shell']), text.trim());
});

test('otcl: 一个块里多个调用 / 大小写变体', () => {
  const good = '```otcl\nexec_shell({command:"ls"});\nread_file({path:\'/etc/hosts\'});\n```';
  const calls = parseOtclCalls(good);
  assert.deepEqual(calls.map((c) => c.name), ['exec_shell', 'read_file']);
  assert.deepEqual(JSON.parse(calls[1].arguments), { path: '/etc/hosts' });

  const mixedCase = '```OTCL\nexec_shell({command:"a"});\n```';
  assert.deepEqual(parseOtclCalls(mixedCase).map((c) => c.name), ['exec_shell']);
});

test('otcl: 多个块按顺序解析', () => {
  const text = `${wrap('exec_shell({command:"a"});')}\n中间\n${wrap('read_file({path:"b"});')}`;
  assert.deepEqual(parseOtclCalls(text).map((c) => c.name), ['exec_shell', 'read_file']);
});

test('otcl: 围栏没闭合（输出截断）时也尽量解析已完整的调用', () => {
  const text = '```otcl\nexec_shell({command:"ls", timeout:10';
  const calls = parseOtclCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'ls', timeout: 10 });
});

test('otcl: 嵌套数组 / 对象 / 布尔 / null / 尾逗号 / 注释 / 裸单词', () => {
  const text = wrap(`exec_shell({
    command: ls, // 裸单词当字符串
    options: {recursive:true, depth:null, tags:["a","b",],},
  });`);
  const calls = parseOtclCalls(text);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].arguments), {
    command: 'ls',
    options: { recursive: true, depth: null, tags: ['a', 'b'] },
  });
});

test('otcl: 块内未声明的工具名也照实解析（由客户端报 unknown tool）', () => {
  const calls = parseOtclCalls(wrap('observe_screen({include_ui_tree:true});'), ['launch_app']);
  assert.deepEqual(calls.map((c) => c.name), ['observe_screen']);
});

test('findOtclBlocks: 完整块 / 未闭合块 / 没有块', () => {
  assert.deepEqual(findOtclBlocks('没有标记'), []);
  const one = findOtclBlocks(`前\n${wrap('a();')}\n后`);
  assert.equal(one.length, 1);
  assert.equal(one[0].closed, true);
  const unclosedText = '前\n```otcl\na();';
  const unclosed = findOtclBlocks(unclosedText);
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].closed, false);
  assert.equal(unclosed[0].end, unclosedText.length);
});

/* ---------------------------------------------------------------- 内容清洗 */

test('stripToolMarkup: 只删 ```otcl 块，块外正文和代码都保留', () => {
  const text = [
    '下面是回答：',
    wrap('exec_shell({command:"ls"});'),
    '用户要的示例代码：',
    'app.get({path:"/"});',
  ].join('\n');
  const cleaned = stripToolMarkup(text, ['exec_shell']);
  assert.ok(!cleaned.includes('```otcl'));
  assert.ok(!cleaned.includes('exec_shell'));
  assert.match(cleaned, /下面是回答/);
  assert.match(cleaned, /app\.get\(\{path:"\/"\}\);/);
});

test('findToolMarkup: 整个 ```otcl 块被识别为 TOOL_CALL', () => {
  const text = `前\n${wrap('exec_shell({command:"ls"});')}\n后`;
  const blocks = findToolMarkup(text, ['exec_shell']);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'TOOL_CALL');
});

/* ---------------------------------------------------------------- 流式过滤 */

function streamAll(chunks) {
  const filter = new OtclBlockStreamFilter();
  let out = '';
  for (const chunk of chunks) out += filter.push(chunk).content;
  out += filter.finalize().content;
  return out;
}

test('流式：围栏块被整段剥掉，块外正文/代码照常输出', () => {
  const text = `回答\n${wrap('exec_shell({command:"ls"});')}\n代码：\napp.get({path:"/"});\n`;
  const out = streamAll([...text]);
  assert.ok(!out.includes('```otcl'));
  assert.ok(!out.includes('exec_shell'));
  assert.match(out, /回答/);
  assert.match(out, /app\.get\(\{path:"\/"\}\);/);
});

test('流式：围栏标记被 chunk 切开也能正确进入/退出块', () => {
  const out = streamAll(['前文`', '``otcl\nexec_shell({command:"ls"});\n``', '`后文']);
  assert.ok(!out.includes('exec_shell'));
  assert.ok(!out.includes('otcl'));
  assert.match(out, /前文/);
  assert.match(out, /后文/);
});

test('流式：围栏没闭合时整块丢弃，不泄漏到正文', () => {
  const out = streamAll(['前文```otcl\nexec_shell({command:"ls"});']);
  assert.equal(out.trim(), '前文');
});

test('流式：普通 ```js 代码块和正文里的反引号不会被误吞', () => {
  const out = streamAll(['代码：\n```js\nx()\n```\n', '另外 `inline` 也保留']);
  assert.match(out, /```js/);
  assert.match(out, /x\(\)/);
  assert.match(out, /`inline`/);
});
