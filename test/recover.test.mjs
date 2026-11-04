import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatRunner } from '../src/chat-runner.mjs';

/** 只提供 chat-runner 用得到的字段 */
const fakeConfig = {
  runtime: {
    maxPromptChars: 100_000,
    maxAttachmentChars: 2_000_000,
    overflowToAttachment: true,
  },
};

const fakeLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  child() {
    return this;
  },
};

/** 记录每次 chat 的入参，按顺序返回预置的响应 */
function makeWeb(responses) {
  const calls = [];
  return {
    supportsContinue: true,
    calls,
    uploadImages: async () => [],
    uploadAttachments: async () => [],
    async chat(options) {
      calls.push(options);
      const next = responses.shift();
      if (!next) throw new Error('fake web: 没有更多预置响应');
      if (next instanceof Error) throw next;
      return {
        text: next.text ?? '',
        reasoning: next.reasoning ?? '',
        elapsedMs: next.elapsedMs ?? 1,
        sessionId: next.sessionId ?? 'session-1',
        messageId: next.messageId ?? 'message-1',
        accountIndex: next.accountIndex ?? 0,
      };
    },
  };
}

const TRUNCATED_DSML = '\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="bash">\n';
const REST_OF_DSML =
  '\n<｜DSML｜ parameter name="command" string="true">uname -a</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

test('纠错：模型只吐半截 DSML 时，在同一会话里续写并解析出工具调用', async () => {
  const web = makeWeb([
    { text: TRUNCATED_DSML, reasoning: '想调用 bash', sessionId: 'sess-9', messageId: 'msg-9', accountIndex: 1 },
    { text: REST_OF_DSML, reasoning: '', sessionId: 'sess-9', messageId: 'msg-10' },
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '看看内核版本' }],
    tools: [
      {
        type: 'function',
        function: { name: 'bash', description: 'run shell', parameters: { type: 'object', properties: {} } },
      },
    ],
    thinking: true,
    stream: false,
  });

  // 第一次是正常请求，第二次是同一会话的纠错续写
  assert.equal(web.calls.length, 2, '应当纠错续写一次');
  assert.equal(web.calls[0].continueSessionId ?? null, null, '首次请求不续写');
  assert.equal(web.calls[1].continueSessionId, 'sess-9', '纠错必须复用同一个会话');
  assert.equal(web.calls[1].parentMessageId, 'msg-9', '必须挂到上一条消息上');
  assert.equal(web.calls[1].thinking, false, '纠错不再开深度思考');
  assert.equal(web.calls[1].continueAccountIndex, 1, '会话是账号绑定的，纠错必须回到同一个账号');

  // 两段拼起来能解析出完整调用
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'bash');
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { command: 'uname -a' });
  assert.equal(result.content.trim(), '', '协议块不应残留到正文');
});

test('纠错：模型只输出思考、正文为空时，续写拿回正文', async () => {
  const web = makeWeb([
    { text: '', reasoning: '想了很久但没写出来', sessionId: 'sess-2', messageId: 'msg-2' },
    { text: '最终答案是 42。', reasoning: '', sessionId: 'sess-2', messageId: 'msg-3' },
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '问题' }],
    tools: [],
    thinking: true,
    stream: false,
  });

  assert.equal(web.calls.length, 2);
  assert.equal(result.content, '最终答案是 42。');
  assert.equal(result.toolCalls.length, 0);
});

test('纠错：续写仍为空时不抛错，按原结果返回（不打断调用方）', async () => {
  const web = makeWeb([
    { text: '', reasoning: '', sessionId: 'sess-3', messageId: 'msg-3' },
    { text: '', reasoning: '', sessionId: 'sess-3', messageId: 'msg-4' },
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '问题' }],
    tools: [],
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 2, '仍然只纠错一次，不无限重试');
  assert.equal(result.content, '');
  assert.equal(result.toolCalls.length, 0);
});

test('纠错：续写本身报错时按原结果返回', async () => {
  const web = makeWeb([
    { text: TRUNCATED_DSML, sessionId: 'sess-4', messageId: 'msg-5' },
    new Error('上游炸了'),
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '问题' }],
    tools: [],
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 2);
  assert.equal(result.content, '');
  assert.equal(result.toolCalls.length, 0);
});

test('纠错：引擎不支持续写（没有 supportsContinue）时不发第二次请求', async () => {
  const web = makeWeb([{ text: '', reasoning: '只有思考', sessionId: 'sess-5' }]);
  delete web.supportsContinue;
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '问题' }],
    tools: [],
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '不支持续写就只发一次');
  assert.equal(result.content, '');
});

test('纠错：正常输出不会触发续写', async () => {
  const web = makeWeb([{ text: '正常回答', sessionId: 'sess-6', messageId: 'msg-6' }]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '问题' }],
    tools: [],
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '正常轮次不该多付一次请求');
  assert.equal(result.content, '正常回答');
});
