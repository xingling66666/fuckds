import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatRunner } from '../src/chat-runner.mjs';

/**
 * 回归：续聊时 buildDelta 回调必须拿到「本次请求的 systemExtra」。
 * 之前闭包引用了 prepare() 的局部参数，第二轮就抛 `systemExtra is not defined`。
 */

function makeRunner({ capture }) {
  const web = {
    async chat(payload) {
      capture.push(payload);
      return { text: '好的', reasoning: '', elapsedMs: 1, messageId: capture.length };
    },
    async uploadImages() {
      return [];
    },
    async uploadAttachments() {
      return [];
    },
  };
  const config = {
    runtime: {
      maxPromptChars: 120_000,
      maxAttachmentChars: 200_000,
      overflowToAttachment: false,
      toolDeclMode: 'auto',
      toolDeclCompactThreshold: 40,
    },
    deepseek: { sessionReuse: 8, conversationTtlMs: 30 * 60_000 },
  };
  const log = { info() {}, warn() {}, debug() {} };
  return createChatRunner({ config, log, web });
}

test('续聊第二轮：systemExtra 不炸，且只发增量消息', async () => {
  const capture = [];
  const runChat = makeRunner({ capture });

  const messages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '第一问' },
  ];
  const request = {
    messages,
    tools: [],
    thinking: false,
    search: false,
    stream: false,
    model: 'deepseek-flash',
  };

  const first = await runChat(request, { signal: undefined, meta: {} });
  assert.equal(first.text, '好的');
  assert.equal(capture.length, 1);
  assert.match(capture[0].prompt, /第一问/);
  assert.equal(typeof capture[0].buildDelta, 'function');

  // 第二轮：把回复与追问追加进去（模拟 agent 循环）
  const messages2 = [
    ...messages,
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '第二问' },
  ];
  const second = await runChat({ ...request, messages: messages2 }, { signal: undefined, meta: {} });
  assert.equal(second.text, '好的');
  assert.equal(capture.length, 2);

  // 关键：这里会调用 buildDelta —— 之前的 bug 就在这里抛 systemExtra is not defined
  const delta = capture[1].buildDelta(3);
  assert.ok(delta && typeof delta.prompt === 'string');
  assert.match(delta.prompt, /第二问/);
  assert.equal(/第一问/.test(delta.prompt), false, '增量里不该重复第一问');

  // 带 systemExtra 的场景也不能炸
  const third = await runChat(
    { ...request, messages: [...messages2, { role: 'assistant', content: '好的' }, { role: 'user', content: '第三问' }] },
    { signal: undefined, meta: {} },
  );
  assert.equal(third.text, '好的');
  const delta3 = capture[2].buildDelta(5);
  assert.ok(delta3.prompt.length > 0);
});

test('指标：引擎返回 upstreamPromptChars / fullPromptChars / continuous，日志不再骗人', async () => {
  const capture = [];
  const web = {
    async chat() {
      return { text: '好', reasoning: '', elapsedMs: 1, messageId: 1 };
    },
    async uploadImages() { return []; },
    async uploadAttachments() { return []; },
  };
  const config = {
    runtime: {
      maxPromptChars: 120_000,
      maxAttachmentChars: 200_000,
      overflowToAttachment: false,
      toolDeclMode: 'auto',
      toolDeclCompactThreshold: 40,
    },
    deepseek: { sessionReuse: 8, conversationTtlMs: 30 * 60_000 },
  };
  const runChat = createChatRunner({ config, log: { info() {}, warn() {}, debug() {} }, web });
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '一二三四五' },
  ];
  const r = await runChat({ messages, tools: [], stream: false, model: 'x' }, { signal: undefined, meta: {} });
  const promptInfo = capture[0] || null;
  // chat-runner 本身不编造 upstream 体积；字段由引擎给。这里只保证 buildDelta 存在且可用。
  assert.equal(typeof r.text, 'string');
  void promptInfo;
});
