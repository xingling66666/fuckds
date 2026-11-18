import test from 'node:test';
import assert from 'node:assert/strict';

import { DeepSeekWeb } from '../src/browser/driver.mjs';
import { AuthExpiredError, RateLimitError } from '../src/errors.mjs';
import { createServer } from '../src/server.mjs';
import { ToolMarkupStreamFilter } from '../src/openai/tool-text.mjs';
import { parseToolCalls } from '../src/prompt/tools.mjs';
import { createLogger } from '../src/logger.mjs';
import { makeConfig, requireBrowser, closeBrowser } from './helpers/browser.mjs';
import { startFakeDeepSeek } from './helpers/fake-deepseek.mjs';

const logger = createLogger('error');

const driverConfig = (baseUrl, overrides = {}) =>
  makeConfig({
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_USER_TOKEN: 'test-token-0123456789abcdef',
    POLL_INTERVAL_MS: '40',
    SEND_INTERVAL_MS: '0',
    RATE_LIMIT_BACKOFF_MS: '500',
    SETTLE_MS: '250',
    FIRST_TOKEN_TIMEOUT_MS: '15000',
    REQUEST_TIMEOUT_MS: '30000',
    IDLE_SHUTDOWN_MS: '0',
    BROWSER_NAV_TIMEOUT_MS: '15000',
    ...overrides,
  });

test('驱动：输入 → 回车 → 流式读取回答与思考', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const deltas = [];
    const thinking = [];
    const result = await web.chat({
      prompt: '# MESSAGES:\n## USER_ROLE_MESSAGES:\n你好',
      onDelta: (d) => deltas.push(d),
      onThinking: (d) => thinking.push(d),
    });

    assert.equal(result.text, '回答#1');
    assert.equal(result.reasoning, '先想一想');
    assert.equal(deltas.join(''), '回答#1');
    assert.equal(thinking.join(''), '先想一想');
    assert.ok(result.elapsedMs > 0);
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：第二次请求会先点「开启新对话」，上下文不串', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const first = await web.chat({ prompt: '第一轮' });
    assert.equal(first.text, '回答#1');

    const second = await web.chat({ prompt: '第二轮' });
    // 假页面里回答带序号，序号一直是 1 说明确实清空了旧对话
    assert.equal(second.text, '回答#1');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：思考块晚到时也必须排在正文前面', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url, { REASONING_HOLD_MS: '1500' }), logger });
  try {
    const events = [];
    await web.chat({
      prompt: 'LATE_THINK 你好',
      onThinking: (text) => events.push({ type: 'reasoning', text }),
      onDelta: (text) => events.push({ type: 'content', text }),
    });

    const firstContent = events.findIndex((e) => e.type === 'content');
    const lastReasoning = events.map((e) => e.type).lastIndexOf('reasoning');
    assert.ok(firstContent >= 0, '应该有正文增量');
    assert.ok(lastReasoning >= 0, '应该有思考增量');
    assert.ok(
      lastReasoning < firstContent,
      `思考必须全部在正文之前，实际顺序: ${events.map((e) => e.type).join(',')}`,
    );
    assert.equal(events.filter((e) => e.type === 'reasoning').map((e) => e.text).join(''), '先想一想');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：工具调用文本能解析成 tool_calls', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const result = await web.chat({ prompt: 'USE_TOOL please' });
    const calls = parseToolCalls(result.text, ['exec_shell']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'exec_shell');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：登录页被识别为 token 失效', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({
    config: driverConfig(`${fixture.url}/sign_in`, { BROWSER_NAV_TIMEOUT_MS: '2500' }),
    logger,
  });
  try {
    await assert.rejects(
      () => web.chat({ prompt: '你好' }),
      (err) => err instanceof AuthExpiredError,
    );
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：客户端中断会停止生成并释放页面', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  const controller = new AbortController();
  try {
    setTimeout(() => controller.abort(), 120);
    await assert.rejects(
      () => web.chat({ prompt: '慢一点', signal: controller.signal, onDelta: () => {} }),
      (err) => err.code === 'client_closed' || err.name === 'AbortError',
    );
    assert.equal(web.status().busy, 0);
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DOM 丢掉尾部 DO 块时，用页面原始补全流把工具调用救回来', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    // 假页面里 DOM 故意在 DO 块前截断，只有 /api/v0/chat/completion 的原始 SSE 含完整回答
    const result = await web.chat({ prompt: 'USE_TOOL_DROP_DOM please' });

    assert.match(result.text, /DO:\{"name":"exec_shell"/);
    const calls = parseToolCalls(result.text, ['exec_shell']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'exec_shell');
    assert.deepEqual(JSON.parse(calls[0].arguments), { command: 'uname -a' });
    assert.equal(result.reasoning, '先想一想');
    assert.equal(result.timings.captureBodies, 1);
    assert.ok(result.timings.captureMs >= 0);
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DOM 完全读不到内容时，原始补全流把结果救回来', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({
    // 拉短首字超时，让 DOM 循环先抛 TimeoutError，验证救生艇逻辑
    config: driverConfig(fixture.url, { FIRST_TOKEN_TIMEOUT_MS: '900' }),
    logger,
  });
  try {
    const result = await web.chat({ prompt: 'CAPTURE_ONLY please' });

    // DOM 里一个字符都没有，但页面请求的原始 SSE 里答案完整
    assert.equal(result.text, '原始流里的回答');
    assert.equal(result.reasoning, '先想一想');
    assert.equal(result.timings.captureBodies, 1);
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DOM 结束后回退缩短时，仍返回历史最长文本（永不缩水）', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  // 关掉原始流，只验证纯 DOM 路径的「最长版本」保护
  const web = new DeepSeekWeb({
    config: driverConfig(fixture.url, { BROWSER_CAPTURE: 'false' }),
    logger,
  });
  try {
    const result = await web.chat({ prompt: 'USE_TOOL_DOM_ROLLBACK please' });

    assert.match(result.text, /DO:\{"name":"exec_shell"/);
    const calls = parseToolCalls(result.text, ['exec_shell']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'exec_shell');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：原始流提示限流时照旧抛 RateLimitError（不被救生艇吞掉）', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({
    config: driverConfig(fixture.url, {
      FIRST_TOKEN_TIMEOUT_MS: '400',
      RATE_LIMIT_BACKOFF_MS: '10',
    }),
    logger,
  });
  try {
    await assert.rejects(
      () => web.chat({ prompt: 'RATE_LIMIT please' }),
      (err) => err instanceof RateLimitError,
    );
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DOM 半途截断且 markdown 序列化与 raw 分叉时，最终文本仍完整（流式补尾靠上层对齐）', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    // DOM 在第二条列表项之前就停止更新，且 DOM 反向序列化的空行/行尾空格与 raw 不同
    const deltas = [];
    const result = await web.chat({
      prompt: 'DIVERGE_TRUNCATE 请写一段带标题和列表的回答',
      onDelta: (d) => deltas.push(d),
    });

    assert.match(result.text, /最后一段总结/, `权威文本应完整: ${JSON.stringify(result.text)}`);
    assert.match(result.text, /第二项/);
    assert.equal(result.timings.captureComplete, true);
    assert.equal(result.timings.captureBodies, 1);
    // DOM 流式只到第一项；driver 不做非前缀硬拼（交给 chat-runner 收尾对齐）
    assert.ok(!deltas.join('').includes('最后一段总结'), 'driver 不该把分叉的 raw 硬拼进流');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DOM 渲染滞后但生成结束后追平时，流式增量能补出完整尾部', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const deltas = [];
    const result = await web.chat({
      prompt: 'DIVERGE_LAG 请写一段带标题和列表的回答',
      onDelta: (d) => deltas.push(d),
    });

    assert.match(result.text, /最后一段总结/);
    assert.match(deltas.join(''), /最后一段总结/, '生成结束后补读的最终 DOM 应把尾部发出去');
    assert.equal(result.timings.endReason, 'stopHidden');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：同一轮两次 completion 请求只取完整的那段，不重复拼接', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const deltas = [];
    const result = await web.chat({
      prompt: 'DOUBLE_COMPLETION 你好',
      onDelta: (d) => deltas.push(d),
    });

    // 第一次请求被中断、第二次完整：结果必须等于第二次的完整回答，且只出现一次
    assert.equal(result.timings.captureResponses, 2, '这一轮页面发了两次补全请求');
    assert.equal(result.timings.captureBodies, 1, '只有完整的那段被采用');
    assert.equal(result.timings.captureFailedBodies, 1, '第一次请求的 body 读失败');
    assert.equal(result.text, '第一段\n\n第二次请求的完整回答，只应出现一次。');
    assert.equal((result.text.match(/完整回答/g) || []).length, 1, '不能出现重复文本');
    assert.equal(
      deltas.join('').replace(/\s+/g, ''),
      result.text.replace(/\s+/g, ''),
      '流式增量（DOM）应与权威文本语义一致',
    );
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：DO 块之后的自然语言尾巴不会丢', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const result = await web.chat({ prompt: 'TAIL_AFTER_TOOL 看看内核' });
    assert.match(result.text, /DO:\{"name":"exec_shell"/);
    assert.match(result.text, /执行完成，内核版本如上。/, 'DO 之后的自然语言必须保留');
    const calls = parseToolCalls(result.text, ['exec_shell']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'exec_shell');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：原始补全流读失败但 DOM 完整时，完整恢复不丢内容', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({ config: driverConfig(fixture.url), logger });
  try {
    const deltas = [];
    const result = await web.chat({
      prompt: 'CAPTURE_FAIL 你好',
      onDelta: (d) => deltas.push(d),
    });

    assert.equal(result.timings.captureSawResponse, true);
    assert.equal(result.timings.captureComplete, false);
    assert.equal(result.text, '捕获失败但 DOM 里有完整回答。');
    assert.equal(deltas.join(''), '捕获失败但 DOM 里有完整回答。');
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('驱动：原始补全流和 DOM 都不完整、页面未确认结束时显式报错（不静默截断）', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const web = new DeepSeekWeb({
    config: driverConfig(fixture.url, { REQUEST_TIMEOUT_MS: '4000', FIRST_TOKEN_TIMEOUT_MS: '15000' }),
    logger,
  });
  try {
    await assert.rejects(
      () => web.chat({ prompt: 'CAPTURE_FAIL_TRUNCATED 你好' }),
      (err) => {
        assert.equal(err.code, 'stream_incomplete', `实际错误: ${err.code} ${err.message}`);
        assert.match(err.message, /截断|没有收完整/);
        return true;
      },
    );
  } finally {
    await web.close();
    await fixture.close();
  }
});


/* ------------------------------------------------------------------ *
 * 端到端：真实 browser driver + fake 页面 + 完整 server（SSE 一致性验收）
 * ------------------------------------------------------------------ */

const normalizeText = (text) => String(text || '').replace(/\s+/g, '');

async function withChatServer(web, config, fn) {
  const server = createServer({ config, logger, web });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const postJson = (base, body) =>
  fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 解析 OpenAI 流式 SSE，返回客户端视角的拼接结果 */
function readOpenAiStream(sseText) {
  const chunks = sseText
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => block.replace(/^data:\s?/, '').trim())
    .filter((data) => data && data !== '[DONE]')
    .map((data) => JSON.parse(data));
  return {
    content: chunks.map((c) => c.choices[0]?.delta?.content ?? '').join(''),
    reasoning: chunks.map((c) => c.choices[0]?.delta?.reasoning_content ?? '').join(''),
    toolCalls: chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? []),
    finishReason: chunks.find((c) => c.choices[0]?.finish_reason)?.choices[0]?.finish_reason ?? null,
  };
}

test('端到端：DOM 半途截断 + markdown 序列化分叉时，流式 content 与非流式 content 一致', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const config = driverConfig(fixture.url);
  const web = new DeepSeekWeb({ config, logger });
  try {
    await withChatServer(web, config, async (base) => {
      const prompt = 'DIVERGE_TRUNCATE 请写一段带标题和列表的回答';
      const messages = [{ role: 'user', content: prompt }];

      const finalRes = await postJson(base, { model: 'deepseek-flash', messages });
      assert.equal(finalRes.status, 200);
      const finalJson = await finalRes.json();
      const finalContent = finalJson.choices[0].message.content;

      const streamRes = await postJson(base, { model: 'deepseek-flash', stream: true, messages });
      assert.equal(streamRes.status, 200);
      const streamed = readOpenAiStream(await streamRes.text());

      // 关键保证：客户端收到的 delta.content 拼接 == 非流式 content（语义一致）
      assert.match(finalContent, /最后一段总结/);
      assert.equal(
        normalizeText(streamed.content),
        normalizeText(finalContent),
        `流式 content 被截断/多了内容:\n流式=${JSON.stringify(streamed.content)}\n最终=${JSON.stringify(finalContent)}`,
      );
      // 尾部内容确实送达，且没有重复
      assert.match(streamed.content, /第二项/);
      assert.match(streamed.content, /最后一段总结/);
      assert.equal((streamed.content.match(/第一项/g) || []).length, 1, '不能出现重复文本');
      assert.equal(streamed.finishReason, 'stop');
      assert.equal(
        normalizeText(streamed.reasoning),
        normalizeText(finalJson.choices[0].message.reasoning_content),
      );
    });
  } finally {
    await web.close();
    await fixture.close();
  }
});

test('端到端：DO 之后的自然语言尾巴在流式与非流式里都不丢，tool_calls 正常', async (t) => {
  const browser = await requireBrowser(t);
  if (!browser) return;

  const fixture = await startFakeDeepSeek();
  const config = driverConfig(fixture.url);
  const web = new DeepSeekWeb({ config, logger });
  try {
    await withChatServer(web, config, async (base) => {
      const messages = [{ role: 'user', content: 'TAIL_AFTER_TOOL 看看内核版本' }];
      const tools = [{ type: 'function', function: { name: 'exec_shell', description: '执行命令' } }];

      const finalRes = await postJson(base, { model: 'deepseek-flash', messages, tools });
      const finalJson = await finalRes.json();
      const finalMessage = finalJson.choices[0].message;
      assert.equal(finalMessage.tool_calls.length, 1);
      assert.match(finalMessage.content, /执行完成，内核版本如上/);

      const streamRes = await postJson(base, {
        model: 'deepseek-flash',
        stream: true,
        messages,
        tools,
      });
      const streamed = readOpenAiStream(await streamRes.text());

      assert.equal(streamed.toolCalls.length, 1);
      assert.equal(streamed.toolCalls[0].function.name, 'exec_shell');
      assert.ok(!streamed.content.includes('DO:'), `content 不该包含协议行: ${streamed.content}`);
      assert.match(streamed.content, /执行完成，内核版本如上/, 'DO 后面的自然语言尾巴丢了');
      assert.equal(normalizeText(streamed.content), normalizeText(finalMessage.content));
      assert.equal(streamed.finishReason, 'tool_calls');
    });
  } finally {
    await web.close();
    await fixture.close();
  }
});


test.after(async () => {
  await closeBrowser();
});
