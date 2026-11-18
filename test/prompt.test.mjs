import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import {
  FINAL_ANSWER_HINT,
  SECTION,
  TOOL_RECORD,
  SPECIAL_TOKENS_HEADER,
  SPECIAL_TOKENS_HEADER_CHAT,
  SPECIAL_TOKENS_HEADER_STEALTH,
} from '../src/prompt/special.mjs';
const PUA_C = Object.fromEntries(
  ['TC_OPEN','TC_CLOSE','INVOKE','END_INVOKE','PARAM','VALUE','PARAM_END','ESC','STRING','JSON']
    .map((name, i) => [name, String.fromCharCode(0xe000 + i)]),
);

test('单轮：system + user，按段落标签拼接', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'system', content: '你是一个简洁的助手' },
      { role: 'user', content: '你好' },
    ],
  });

  assert.ok(prompt.startsWith(`# Messages:\n\n${SECTION.system}\n`));
  assert.ok(prompt.includes('你是一个简洁的助手'));
  assert.ok(prompt.includes(`${SECTION.user}\n你好`));
  assert.ok(!prompt.includes(SECTION.assistant));
  // 不该出现空白 section
  assert.ok(!/\n{3,}/.test(prompt));
});

test('多轮：assistant 段落用 assistant 标签，不再补 END 标记', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '第一步' },
      { role: 'assistant', content: '第一步的回答' },
      { role: 'user', content: '第二步' },
    ],
  });

  const order = [
    `${SECTION.user}\n第一步`,
    `${SECTION.assistant}\n第一步的回答`,
    `${SECTION.user}\n第二步`,
  ].map((needle) => prompt.indexOf(needle));

  assert.ok(order.every((i) => i >= 0), `段落缺失: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '段落顺序不对');
  assert.ok(prompt.trimEnd().endsWith(`${SECTION.user}\n第二步`));
  assert.ok(!prompt.includes('< | | END | | >'));
});

test('tools：工具声明渲染成签名式文本（不是 JSON），并且排在对话历史之前', () => {
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
  assert.ok(prompt.includes(SECTION.tools));
  const section = prompt.slice(prompt.indexOf(SECTION.tools), prompt.indexOf(`${SECTION.user}\n`));
  // 声明是签名式文本，不是 JSON
  assert.ok(section.includes('exec_shell(command?: text) — Exec shell command'), section);
  assert.ok(section.includes('read_file() — Read a file'), section);
  assert.ok(!section.includes('{"name"'), '工具声明不该是 JSON');
  // 工具声明必须在第一段 User 之前
  assert.ok(prompt.indexOf(SECTION.tools) < prompt.indexOf(`${SECTION.user}\n`));
});

test('assistant 段放密文块（不是 JSON），执行结果用零宽标记进 user 段', () => {
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

  const expectedBlock =
    `${PUA_C.TC_OPEN}${PUA_C.INVOKE}exec_shell` +
    `${PUA_C.PARAM}command${PUA_C.VALUE}uname -a${PUA_C.PARAM_END}` +
    `${PUA_C.END_INVOKE}${PUA_C.TC_CLOSE}`;

  const assistantAt = prompt.indexOf(`${SECTION.assistant}\n`);
  assert.ok(assistantAt >= 0, '缺少 assistant 段');
  const assistantBody = prompt.slice(assistantAt, prompt.indexOf(`${SECTION.user}\n`, assistantAt));
  assert.ok(assistantBody.includes(expectedBlock), 'assistant 段应当用密文块重建调用');

  // 绝不能把调用序列化成 JSON：那是最明显的工具调用特征
  assert.ok(!assistantBody.includes('"args"'), `assistant 段混入了 JSON 调用记录:\n${assistantBody}`);
  assert.ok(!assistantBody.includes('{"name"'), 'assistant 段混入了 JSON 调用记录');

  // 结果：TOOL_RECORD + 纯文本，落在 user 段
  assert.ok(prompt.includes(`${TOOL_RECORD}:\nLinux ubuntu 6.1`), '结果应当用零宽标记 + 纯文本');
  const resultAt = prompt.indexOf('Linux ubuntu 6.1');
  const userBeforeResult = prompt.lastIndexOf(`${SECTION.user}\n`, resultAt);
  assert.ok(userBeforeResult > assistantAt, '结果应落在 user 段里');

  // 历史里不能出现可读标签
  const history = prompt.slice(prompt.indexOf(`${SECTION.user}\n`));
  for (const banned of ['OTC', 'OTCR', 'DSML', '<tool_call>', 'DO:']) {
    assert.ok(!history.includes(banned), `历史里不该出现 ${banned}`);
  }
});

test('连续多个工具结果合并进同一个 user 段（不各开一段）', () => {
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

  const userSegments = prompt.split(`${SECTION.user}\n`).length - 1;
  assert.equal(userSegments, 2, '第一个 user 段 + 结果段，不该每个结果各开一段');
  assert.ok(prompt.includes(`${TOOL_RECORD}:\n结果 A`));
  assert.ok(prompt.includes(`${TOOL_RECORD}:\n结果 B`));
  // 两个调用都在同一个密文块里
  const assistantBody = prompt.slice(prompt.indexOf(`${SECTION.assistant}\n`));
  assert.ok(assistantBody.includes(`${PUA_C.INVOKE}a`));
  assert.ok(assistantBody.includes(`${PUA_C.INVOKE}b`));
});

test('assistant 有正文但原文里没有块时，补一个密文块（调用不能丢）', () => {
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

  const at = prompt.indexOf(`${SECTION.assistant}\n`);
  assert.ok(at >= 0);
  const body = prompt.slice(at);
  assert.ok(body.includes('好的'), 'assistant 原文必须保留');
  const textAt = body.indexOf('好的');
  const blockAt = body.indexOf(PUA_C.TC_OPEN);
  assert.ok(blockAt > textAt, '密文块应接在正文之后');
  assert.ok(body.includes(`${PUA_C.INVOKE}exec_shell`));
  assert.ok(body.includes(`${PUA_C.INVOKE}read_file`));
  assert.ok(!body.includes('"args"'), '不能退回 JSON 序列化');
});

test('assistant 原文里已经带块时不再重复拼', () => {
  const raw =
    `我先查一下。\n${PUA_C.TC_OPEN}${PUA_C.INVOKE}exec_shell` +
    `${PUA_C.PARAM}command${PUA_C.VALUE}uname -r${PUA_C.PARAM_END}${PUA_C.END_INVOKE}${PUA_C.TC_CLOSE}`;
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看下内核' },
      {
        role: 'assistant',
        content: raw,
        tool_calls: [{ id: 'a', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -r"}' } }],
      },
    ],
  });

  const body = prompt.slice(prompt.indexOf(`${SECTION.assistant}\n`));
  const occurrences = body.split(PUA_C.TC_OPEN).length - 1;
  assert.equal(occurrences, 1, '原文已有块时不能再拼一个');
});

test('systemExtra 追加在 SYSTEM 段末尾（协议提示词之前）', () => {
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: '你好' }],
    systemExtra: '额外约束：不要输出 RESULT。',
  });
  assert.ok(prompt.indexOf('额外约束') < prompt.indexOf(`${SECTION.user}\n`));
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

test('协议声明：只教 <plan>/<step> 一种输出格式（去 tool 字样）', () => {
  const text = SPECIAL_TOKENS_HEADER_STEALTH;

  // 现在只教一种格式：XML 信封
  assert.ok(text.includes('<plan>'), '协议必须教 <plan> 信封');
  assert.ok(text.includes('<step name='), '协议必须教 <step> 写法');
  assert.ok(!/____tool____/.test(text), '提示词里不应再出现旧标签');
  assert.ok(text.includes('<args>'), '协议必须教 <args> 参数段');
  // DSML 不再出现在任何提示词里（只留在解析器兜底）
  assert.ok(!/dsml/i.test(text), 'DSML 不应再出现在提示词里');
  assert.ok(!text.includes('```otml'));
  assert.ok(!text.includes('封禁'));
});

test('纯聊天协议声明：不教任何调用语法', () => {
  assert.ok(!/[\uE000-\uE009]/.test(SPECIAL_TOKENS_HEADER_CHAT));
  assert.ok(!SPECIAL_TOKENS_HEADER_CHAT.includes('```otml'));
});

test('段落常量与新协议一致（去特征标签，不再用 ## 段落）', () => {
  assert.equal(SECTION.system, 'System');
  assert.equal(SECTION.tools, '# 本次可用工具');
  assert.equal(SECTION.user, 'User:');
  assert.equal(SECTION.assistant, 'Assistant:');
  // 调用 / 结果不再有段落标签：调用是密文块，结果是 TOOL_RECORD 零宽标记
  assert.equal(SECTION.toolCalls, undefined);
  assert.equal(SECTION.toolResult, undefined);
  assert.equal(TOOL_RECORD, '\u200B\u200B\u200B\u200B');
  // 段落标签里不能再出现 markdown 标题前缀，否则模型会照着写伪造段标题
  for (const label of [SECTION.system, SECTION.user, SECTION.assistant]) {
    assert.ok(!label.trimStart().startsWith('#'), `段落标签不该带 # 前缀: ${label}`);
  }
});

/* --------------------------------------------------- 密文块逐字保真（上下文） */

// 模型实际吐出来的块长这样（eval_javascript / code / typeof window）
const RAW_BLOCK =
  `${PUA_C.TC_OPEN}${PUA_C.INVOKE}eval_javascript` +
  `${PUA_C.PARAM}code${PUA_C.VALUE}typeof window${PUA_C.PARAM_END}` +
  `${PUA_C.END_INVOKE}${PUA_C.TC_CLOSE}`;
const EVAL_TOOL = {
  type: 'function',
  function: { name: 'eval_javascript', description: 'eval', parameters: { type: 'object', properties: { code: { type: 'string' } } } },
};
const EVAL_CALL = [
  { id: 'c1', type: 'function', function: { name: 'eval_javascript', arguments: '{"code":"typeof window"}' } },
];

test('上下文里的块与模型原文逐字一致（不做任何序列化）', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看下窗口' },
      { role: 'assistant', content: RAW_BLOCK, tool_calls: EVAL_CALL },
    ],
    tools: [EVAL_TOOL],
  });

  assert.ok(prompt.includes(RAW_BLOCK), '原文块必须原样出现，一个字符都不能变');
  // 反证：assistant 段里不能退化成 JSON（工具声明段本来就是 JSON，只查历史段落）
  const history = prompt.slice(prompt.indexOf(`${SECTION.assistant}\n`));
  assert.ok(!history.includes('"args"'), `assistant 段混入了 JSON: ${history}`);
  assert.ok(!history.includes('{"name"'), `assistant 段混入了 JSON: ${history}`);
});

test('只有 tool_calls 没有原文时，重建出的块与原文同构', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看下窗口' },
      { role: 'assistant', content: '', tool_calls: EVAL_CALL },
    ],
    tools: [EVAL_TOOL],
  });

  assert.ok(prompt.includes(RAW_BLOCK), `重建块要和原文一致（字符串不加引号/不加类型标记）:\n${prompt}`);
});

test('非字符串参数才加 JSON 标记', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 't', arguments: '{"n":10,"on":true,"list":["a"]}' } },
        ],
      },
    ],
  });

  assert.ok(prompt.includes(`${PUA_C.PARAM}n${PUA_C.JSON}${PUA_C.VALUE}10${PUA_C.PARAM_END}`));
  assert.ok(prompt.includes(`${PUA_C.PARAM}on${PUA_C.JSON}${PUA_C.VALUE}true${PUA_C.PARAM_END}`));
  assert.ok(prompt.includes(`${PUA_C.PARAM}list${PUA_C.JSON}${PUA_C.VALUE}["a"]${PUA_C.PARAM_END}`));
});

/* ------------------------------------------------ DSML 输入 → 密文回写 */

const DSML_TEXT = `先看内核：
<｜DSML｜calls>
<｜DSML｜invoke name="exec_shell">
<｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜calls>`;

test('模型吐 DSML 时：解析照收，但上下文里只留密文块', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看内核' },
      { role: 'assistant', content: DSML_TEXT },
      { role: 'tool', tool_call_id: 'c', name: 'exec_shell', content: 'Linux 6.1' },
    ],
  });

  assert.ok(!prompt.includes('DSML'), '上下文里不能再出现 DSML：模型看什么就会学什么');
  assert.ok(
    prompt.includes(
      `${PUA_C.TC_OPEN}${PUA_C.INVOKE}exec_shell${PUA_C.PARAM}command${PUA_C.VALUE}uname -a${PUA_C.PARAM_END}${PUA_C.END_INVOKE}${PUA_C.TC_CLOSE}`,
    ),
    'DSML 原文要还原成我们的密文块',
  );
  assert.ok(prompt.includes('先看内核'), '正文要保留');
});

test('客户端只回传 tool_calls 时，调用照样进上下文', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看内核' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -a"}' } }],
      },
    ],
  });
  assert.ok(prompt.includes(`${PUA_C.INVOKE}exec_shell`));
});

test('每段工具结果后面都跟一句注意力引导（FINAL_ANSWER_HINT 非空时）', () => {
  if (!FINAL_ANSWER_HINT) return; // 这条提示被清空就不测
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '查两样' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'y', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'a', name: 'x', content: '结果A' },
      { role: 'tool', tool_call_id: 'b', name: 'y', content: '结果B' },
    ],
  });

  const hintCount = prompt.split(FINAL_ANSWER_HINT).length - 1;
  assert.equal(hintCount, 2, '两个结果 → 两次引导');
  // 引导必须紧跟在结果后面（同一段内，且在结果之后）
  const a = prompt.indexOf('结果A');
  const hintAfterA = prompt.indexOf(FINAL_ANSWER_HINT, a);
  assert.ok(hintAfterA > a);
});
