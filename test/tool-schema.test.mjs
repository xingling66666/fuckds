import test from 'node:test';
import assert from 'node:assert/strict';

import { createChatRunner } from '../src/chat-runner.mjs';

const fakeConfig = {
  runtime: {
    maxPromptChars: 100_000,
    maxAttachmentChars: 2_000_000,
    overflowToAttachment: true,
    toolDeclMode: 'compact',
  },
};

const fakeLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };

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
        elapsedMs: 1,
        sessionId: next.sessionId ?? 'sess-1',
        messageId: next.messageId ?? 'msg-1',
        accountIndex: next.accountIndex ?? 0,
      };
    },
  };
}

const schemaCall = (name) =>
  `\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="__tool_schema">\n` +
  `<｜DSML｜ parameter name="name" string="true">${name}</｜DSML｜ parameter>\n` +
  `</｜DSML｜ invoke>\n</｜DSML｜ calls>`;

const realCall = (name, args) =>
  `\n<｜DSML｜ calls>\n<｜DSML｜ invoke name="${name}">\n` +
  Object.entries(args)
    .map(([k, v]) => `<｜DSML｜ parameter name="${k}" string="true">${v}</｜DSML｜ parameter>\n`)
    .join('') +
  `</｜DSML｜ invoke>\n</｜DSML｜ calls>`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: '执行 shell 命令',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: '要执行的命令' }, timeout: { type: 'number' } },
        required: ['command'],
      },
    },
  },
];

test('schema 展开：模型先查 __tool_schema，服务端补回定义后返回真实调用', async () => {
  const web = makeWeb([
    { text: schemaCall('bash'), sessionId: 'sess-9', messageId: 'msg-9' },
    { text: realCall('bash', { command: 'uname -a' }), sessionId: 'sess-9', messageId: 'msg-10' },
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '看看内核版本' }],
    tools,
    thinking: true,
    stream: false,
  });

  assert.equal(web.calls.length, 2, '应当续写一次把 schema 喂回去');
  assert.equal(web.calls[1].continueSessionId, 'sess-9', '必须复用同一个会话');
  assert.equal(web.calls[1].parentMessageId, 'msg-9', '必须挂到上一条消息');
  assert.equal(web.calls[1].thinking, false, '查 schema 不再开思考');

  // 续写的 prompt 里必须带完整定义（含参数说明），否则模型还是不知道结构
  const fed = web.calls[1].prompt;
  assert.ok(fed.includes('"command"'), `应包含完整参数定义：${fed.slice(0, 200)}`);
  assert.ok(fed.includes('要执行的命令'), '应包含参数描述');

  // 对客户端只暴露真实调用，__tool_schema 不能漏出去
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'bash');
  assert.deepEqual(JSON.parse(result.toolCalls[0].arguments), { command: 'uname -a' });
  assert.ok(!result.toolCalls.some((call) => call.name === '__tool_schema'), '伪工具不能返回给客户端');
});

test('schema 展开：没有 __tool_schema 时不发多余请求', async () => {
  const web = makeWeb([{ text: realCall('bash', { command: 'pwd' }), sessionId: 'sess-1' }]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '看目录' }],
    tools,
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '正常轮次不该多付一次请求');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'bash');
});

test('schema 展开：引擎不支持续写时不展开，也不把伪工具漏给客户端', async () => {
  const web = makeWeb([{ text: schemaCall('bash'), sessionId: 'sess-1' }]);
  delete web.supportsContinue;
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '看内核版本' }],
    tools,
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '不支持续写就只发一次');
  assert.ok(!result.toolCalls.some((call) => call.name === '__tool_schema'), '伪工具必须被过滤掉');
});

test('schema 展开：模型查一个不存在的工具时不死循环', async () => {
  const web = makeWeb([{ text: `我来查一下${schemaCall('not_exist')}`, sessionId: 'sess-1' }]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: 'x' }],
    tools,
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '查不到就不要再续写');
  assert.equal(result.toolCalls.length, 0);
  assert.equal(result.content.trim(), '我来查一下');
});

test('schema 模式：compact 模式下提示词里带「压缩索引」说明', async () => {
  const web = makeWeb([{ text: '好的', sessionId: 'sess-1' }]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  await runChat({
    messages: [{ role: 'user', content: '你好' }],
    tools,
    thinking: false,
    stream: false,
  });

  const prompt = web.calls[0].prompt;
  assert.ok(prompt.includes('工具列表是压缩索引'), '应当告诉模型可以查完整定义');
  assert.ok(prompt.includes('__tool_schema'), '应当给出查询写法');
  assert.ok(prompt.includes('bash(command:string*'), '应当是压缩格式');
});

test('schema 展开：客户端自己声明了 __tool_schema 时不劫持', async () => {
  const ownTool = {
    type: 'function',
    function: { name: '__tool_schema', description: '客户端自己的工具', parameters: { type: 'object', properties: {} } },
  };
  const web = makeWeb([
    { text: realCall('__tool_schema', { name: 'x' }), sessionId: 'sess-1', messageId: 'msg-1' },
  ]);
  const runChat = createChatRunner({ config: fakeConfig, log: fakeLog, web });

  const result = await runChat({
    messages: [{ role: 'user', content: '用你自己的 __tool_schema' }],
    tools: [ownTool, ...tools],
    thinking: false,
    stream: false,
  });

  assert.equal(web.calls.length, 1, '不该为它发起 schema 展开');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, '__tool_schema', '客户端自己的同名工具必须照实返回');
});
