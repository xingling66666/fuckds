import test from 'node:test';
import assert from 'node:assert/strict';

import { countTokens, decode, encode, tokenizerInfo } from '../src/tokenizer.mjs';
import { estimateTokens } from '../src/util.mjs';

test('词表规模与 tokenizer.json 一致', () => {
  const info = tokenizerInfo();
  assert.equal(info.vocabSize, 128000);
  assert.ok(info.merges > 127000);
});

test('常见文本的 token 数符合词表', () => {
  assert.equal(countTokens('hello world'), 2);
  assert.equal(countTokens('你好，世界'), 3);
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens(' '), 1);
});

test('任意文本都能 round-trip（分词边界合法）', () => {
  const samples = [
    'The quick brown fox jumps over the lazy dog.',
    '你是deepseek-v4.1-flash-1017模型',
    'function exec_shell(command) { return 1; }',
    '2026年11月16日 13:45',
    '🙂 emoji 测试 mixed 中英 123',
    'line1\nline2\r\ttab',
    JSON.stringify({ a: 1, b: ['x', 'y'] }),
    'U+E000 控制字符 \uE000\uE002search\uE003\uE001',
  ];
  for (const text of samples) {
    assert.equal(decode(encode(text)), text, `round-trip 失败: ${JSON.stringify(text)}`);
  }
});

test('特殊 token 单独算一个', () => {
  const text = '<｜begin▁of▁sentence｜>你好';
  const ids = encode(text);
  assert.equal(ids.length, countTokens(text));
  assert.ok(countTokens(text) >= 2);
  assert.equal(decode(ids), text);
});

test('usage 走真实分词（不再按字符估）', () => {
  // "hello world"：字符估算 3，真实 2
  assert.equal(estimateTokens('hello world'), 2);
  // 中文：字符估算 3，真实也是 3
  assert.equal(estimateTokens('你好，世界'), 3);
  // 长英文：字符估算会明显高估
  const english = 'The quick brown fox jumps over the lazy dog. '.repeat(10);
  const chars = Math.ceil(english.length / 4);
  assert.ok(estimateTokens(english) < chars, `真实分词应少于字符估算（${estimateTokens(english)} vs ${chars}）`);
});
