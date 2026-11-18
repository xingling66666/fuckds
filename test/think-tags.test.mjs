import test from 'node:test';
import assert from 'node:assert/strict';

import { extractThinkBlocks, ThinkTagStreamFilter } from '../src/openai/think-tags.mjs';

/* ---------------------------------------------------------------- 完整文本 */

test('extract: <think> 内容抽成 reasoning，正文里不留标签', () => {
  const { content, reasoning } = extractThinkBlocks('<think>先思考</think>你好！');
  assert.equal(content, '你好！');
  assert.equal(reasoning, '先思考');
});

test('extract: 多个 think 块 / 大小写 / 属性都认', () => {
  const { content, reasoning } = extractThinkBlocks(
    '开头<think>推理A</think>中间<THINK class="x">推理B</THINK>结尾',
  );
  assert.equal(content, '开头中间结尾');
  assert.match(reasoning, /推理A/);
  assert.match(reasoning, /推理B/);
});

test('extract: 没有 think 标签时原样返回', () => {
  assert.deepEqual(extractThinkBlocks('普通回答'), { content: '普通回答', reasoning: '' });
  assert.deepEqual(extractThinkBlocks(''), { content: '', reasoning: '' });
});

test('extract: 未闭合的 <think> 到结尾都算思考内容', () => {
  const { content, reasoning } = extractThinkBlocks('开头<think>还没想完');
  assert.equal(content, '开头');
  assert.equal(reasoning, '还没想完');
});

/* ---------------------------------------------------------------- 流式 */

function feed(chunks) {
  const filter = new ThinkTagStreamFilter();
  let content = '';
  let reasoning = '';
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    content += out.content;
    reasoning += out.reasoning;
  }
  const tail = filter.flush();
  return { content: content + tail.content, reasoning: reasoning + tail.reasoning };
}

test('stream: 标签被 chunk 切开也能正确分类', () => {
  const out = feed(['<thi', 'nk>想一', '下</thin', 'k>你', '好']);
  assert.equal(out.content, '你好');
  assert.equal(out.reasoning, '想一下');
});

test('stream: 多个 think 块和正文交错', () => {
  const out = feed(['前', '<think>', 'A', '</think>', '中', '<think>B</think>', '后']);
  assert.equal(out.content, '前中后');
  assert.equal(out.reasoning, 'AB');
});

test('stream: 没有标签时原样输出正文', () => {
  const out = feed(['你', '好', '！']);
  assert.equal(out.content, '你好！');
  assert.equal(out.reasoning, '');
});

test('stream: 半截标签扣住，不会漏进 content', () => {
  const filter = new ThinkTagStreamFilter();
  const first = filter.push('正文<thi');
  assert.equal(first.content, '正文');
  assert.equal(first.reasoning, '');
  const second = filter.push('nk>思考</think>结尾');
  assert.equal(second.reasoning, '思考');
  assert.equal(second.content, '结尾');
});
