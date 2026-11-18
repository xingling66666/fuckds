import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import { SECTION, SPECIAL_TOKENS_HEADER } from '../src/prompt/special.mjs';

test('单轮：system + user，按 ## 段落拼接', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'system', content: '你是一个简洁的助手' },
      { role: 'user', content: '你好' },
    ],
  });

  assert.ok(prompt.startsWith('# Messages:\n\n## System\n'));
  assert.ok(prompt.includes(SPECIAL_TOKENS_HEADER.trim()));
  assert.ok(prompt.includes('你是一个简洁的助手'));
  assert.ok(prompt.includes('## User\n你好'));
  assert.ok(!prompt.includes('## Assistant'));
  // 不该出现空白 section
  assert.ok(!/\n{3,}/.test(prompt));
});

test('多轮：assistant 段落用 ## Assistant，不再补 END 标记', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '第一步' },
      { role: 'assistant', content: '第一步的回答' },
      { role: 'user', content: '第二步' },
    ],
  });

  const order = [
    '## User\n第一步',
    '## Assistant\n第一步的回答',
    '## User\n第二步',
  ].map((needle) => prompt.indexOf(needle));

  assert.ok(order.every((i) => i >= 0), `段落缺失: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '段落顺序不对');
  assert.ok(prompt.trimEnd().endsWith('## User\n第二步'));
  assert.ok(!prompt.includes('< | | END | | >'));
});

test('tools：## Tools 用 OTCL 的 JS 函数声明渲染', () => {
  const { prompt, toolNames } = buildPrompt({
    messages: [{ role: 'user', content: '执行 ls' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_shell',
          description: 'Exec shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      { function: { name: 'read_file', description: 'Read a file' } },
    ],
  });

  assert.deepEqual(toolNames, ['exec_shell', 'read_file']);
  assert.ok(prompt.includes('## Tools'));
  const section = prompt.slice(prompt.indexOf('## Tools'), prompt.indexOf('## User'));
  assert.match(section, /function exec_shell\(pars\) \{/);
  assert.match(section, /\/\/ Exec shell command/);
  assert.match(section, /\/\/ pars: \{"type":"object","properties":\{"command":\{"type":"string"\}\}\}/);
  assert.match(section, /function read_file\(pars\) \{/);
  assert.match(section, /\/\/ Read a file/);
  // Tools 必须在第一段 User 之前
  assert.ok(prompt.indexOf('## Tools') < prompt.indexOf('## User'));
});

test('tool 调用单独成 ## OTC 段，结果单独成 ## OTCR 段', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看看内核' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'exec_shell', content: 'Linux ubuntu 6.1' },
      { role: 'user', content: '解释一下' },
    ],
  });

  const toolCallsAt = prompt.indexOf('## OTC\n');
  const toolResultAt = prompt.indexOf('## OTCR\n');
  const nextUserAt = prompt.lastIndexOf('## User\n');

  assert.ok(toolCallsAt > 0 && toolResultAt > toolCallsAt && nextUserAt > toolResultAt);
  assert.ok(prompt.includes('## OTC\n{"name":"exec_shell","args":{"command":"uname -a"}}'));
  // 历史里绝不出现 OTCL / DSML / DO / <tool_call> 等输出语法
  const history = prompt.slice(prompt.indexOf('## User\n'));
  assert.ok(!history.includes('OTCL'));
  assert.ok(!history.includes('DSML'));
  assert.ok(!history.includes('<tool_call>'));
  assert.ok(!history.includes('DO:'));
  assert.ok(!history.includes('exec_shell({'));

  const afterHeader = toolResultAt + '## OTCR'.length;
  const result = JSON.parse(prompt.slice(afterHeader + 1, prompt.indexOf('\n', afterHeader + 1)));
  assert.equal(result.name, 'exec_shell');
  assert.equal(result.result, 'Linux ubuntu 6.1');

  // 模型模仿的是自己的段落：## Assistant 里绝不能出现工具结果或调用
  const assistantAt = prompt.indexOf('## Assistant\n');
  if (assistantAt !== -1) {
    const assistantBody = prompt.slice(assistantAt, toolCallsAt);
    assert.ok(!assistantBody.includes('RESULT'), `assistant 段落混入了 RESULT:\n${assistantBody}`);
    assert.ok(!assistantBody.includes('"args"'), `assistant 段落混入了工具调用:\n${assistantBody}`);
  }
});

test('连续多个 tool 结果合并到同一个 ## Tool_call_result 段', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '查两样' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'a', content: '结果 A' },
      { role: 'tool', tool_call_id: 'call_2', name: 'b', content: '结果 B' },
    ],
  });

  const occurrences = prompt.match(/## OTCR\n/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.ok(prompt.includes('{"name":"a","result":"结果 A"}'));
  assert.ok(prompt.includes('{"name":"b","result":"结果 B"}'));
});

test('assistant 同时有正文和工具调用：正文进 Assistant，调用进 Tool_calls', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看下内核和 hosts' },
      {
        role: 'assistant',
        content: '好的',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -r"}' } },
          { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } },
        ],
      },
    ],
  });

  assert.match(prompt, /## Assistant\n好的/);
  assert.match(prompt, /## OTC\n\{"name":"exec_shell","args":\{"command":"uname -r"\}\}\n\{"name":"read_file","args":\{"path":"\/etc\/hosts"\}\}/);
  // 历史里绝不能出现 OTCL / DSML / native 调用语法（协议提示词里教 OTCL 是允许的）
  const history = prompt.slice(prompt.indexOf('## User\n'));
  assert.ok(!history.includes('OTCL'));
  assert.ok(!history.includes('DSML'));
  assert.ok(!history.includes('<tool_call>'));
  assert.ok(!history.includes('exec_shell({'));
});

test('systemExtra 追加在 SYSTEM 段末尾（协议提示词之前）', () => {
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: '你好' }],
    systemExtra: '额外约束：不要输出 RESULT。',
  });
  assert.ok(prompt.indexOf('额外约束：不要输出 RESULT。') < prompt.indexOf(SPECIAL_TOKENS_HEADER.trim()));
  assert.ok(prompt.indexOf('额外约束') < prompt.indexOf('## User\n'));
});

test('内容 parts 数组会被拼起来', () => {
  const { prompt } = buildPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
    ],
  });
  assert.ok(prompt.includes('第一段\n第二段'));
});

test('图片部分不进入 prompt 正文（由附件上传单独处理）', () => {
  const { prompt } = buildPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.match(prompt, /看图/);
  assert.ok(!prompt.includes('base64'), '图片数据不能拼进 prompt');
});

test('空 messages 报错', () => {
  assert.throws(() => buildPrompt({ messages: [] }), /messages 不能为空/);
});

test('协议声明：教 OTCL 且必须包在 ```otcl 围栏里，不再教 DSML / DO', () => {
  assert.ok(SPECIAL_TOKENS_HEADER.includes('OTCL'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('```otcl'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('!OTCL'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('toolName({param: value});'));
  assert.ok(SPECIAL_TOKENS_HEADER.includes('THINK BLOCK'));
  // 防止模板字符串里误插入反引号把后半段 prompt 截断
  assert.ok(SPECIAL_TOKENS_HEADER.includes('NORMAL ANSWER'));
  assert.ok(SPECIAL_TOKENS_HEADER.trimEnd().endsWith('Answer in the user\'s language.'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('<｜DSML｜'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('DO:{"name"'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('封禁'));
});

test('段落常量与新协议一致', () => {
  assert.equal(SECTION.system, '## System');
  assert.equal(SECTION.tools, '## Tools');
  assert.equal(SECTION.user, '## User');
  assert.equal(SECTION.assistant, '## Assistant');
  assert.equal(SECTION.toolCalls, '## OTC');
  assert.equal(SECTION.toolResult, '## OTCR');
});
