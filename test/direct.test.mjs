import test from 'node:test';
import assert from 'node:assert/strict';

import { DirectEngine, isAuthInvalidMessage } from '../src/direct/client.mjs';
import { createSseParser, applyPatch, createStreamState, contentOf } from '../src/direct/stream.mjs';

/**
 * 直连引擎的集成测试：**不碰真实网络**。
 *
 * fetch 被整体替换成按 URL 路由的假上游，PoW 求解器注入成同步返回的假实现
 * ——这样可以精确断言「请求体 / 请求头 / SSE 解析 / 错误映射」这几件真正容易错的事。
 * （线上真 token 全被吊销，成功的端到端跑不了；这条测试是直连链路的回归保障。）
 */

const BASE = 'https://chat.deepseek.com';

/** 静默 logger：引擎与账号池都会调 info/warn/debug，测试里不关心输出 */
function makeLogger() {
  const logger = { info() {}, warn() {}, debug() {}, error() {} };
  logger.child = () => logger;
  return logger;
}

/** 假 PoW 求解器：记录调用，立刻返回答案 */
function makePow({ answer = 12345 } = {}) {
  const calls = [];
  return {
    calls,
    solve(args) {
      calls.push(args);
      return Promise.resolve({ answer, ms: 1 });
    },
    close() {},
  };
}

function makeConfig(overrides = {}) {
  return {
    deepseek: {
      baseUrl: BASE,
      token: 'tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tokens: ['tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      coldStart: false,
      humanTiming: false,
      deviceProfile: 'chrome-win',
      locale: 'zh_CN',
    },
    runtime: {
      maxPromptChars: 200_000,
      requestTimeoutMs: 10_000,
      accountCooldownMs: 60_000,
      rateLimitBackoffMs: 1_000,
      maxCooldownWaitMs: 5_000,
    },
    direct: { powBin: '/nonexistent/ds-pow' },
    dataDir: '/tmp/ds-direct-test',
    ...overrides,
  };
}

const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sseRes = (frames, status = 200) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
};

/** 装一套假上游；返回调用记录，方便断言请求内容 */
function installFetch(t, { completion, challengeFails = false } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init.method || 'GET', body: init.body, headers: init.headers });

    if (path === '/api/v0/chat_session/create') {
      return jsonRes({ code: 0, msg: '', data: { biz_code: 0, biz_data: { chat_session: { id: 'sess-1' } } } });
    }
    if (path === '/api/v0/chat/create_pow_challenge') {
      if (challengeFails) return jsonRes({ code: 40003, msg: 'INVALID_TOKEN', data: null });
      return jsonRes({
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'c0ffee',
              salt: 'salt',
              difficulty: 144000,
              signature: 'sig',
              expire_at: Math.floor(Date.now() / 1000) + 300,
            },
          },
        },
      });
    }
    if (path === '/api/v0/chat/completion') {
      if (typeof completion === 'function') return completion({ calls });
      return sseRes([
        'event: ready\ndata: {"response_message_id":"m1","request_message_id":"m0","model_type":"default"}\n\n',
        'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"直连"}]}\n\n',
        'data: {"v":"成功"}\n\n',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
        'event: finish\ndata: {}\n\n',
      ]);
    }
    if (path === '/api/v0/users/current') {
      return jsonRes({ code: 0, msg: '', data: { biz_code: 0, biz_data: { user: { email: 'a@b.com' } } } });
    }
    return jsonRes({ code: 404, msg: 'not found' }, 404);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

test('direct: 完整链路（会话 + PoW + SSE）把增量拼成正文，并把 PoW/鉴权头带齐', async (t) => {
  const calls = installFetch(t);
  const pow = makePow({ answer: 987654 });
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: pow });

  const deltas = [];
  const result = await engine.chat({
    prompt: '# Messages:\n## User\n你好',
    thinking: false,
    onDelta: (d) => deltas.push(d),
  });

  assert.equal(result.text, '直连成功');
  assert.equal(deltas.join(''), '直连成功', '增量必须与最终正文一致');
  assert.ok(Number.isFinite(result.elapsedMs));

  const paths = calls.map((c) => c.path);
  assert.ok(paths.includes('/api/v0/chat_session/create'), '要先建会话');
  assert.ok(paths.includes('/api/v0/chat/create_pow_challenge'), '要拿 PoW 挑战');
  assert.ok(paths.includes('/api/v0/chat/completion'), '要打补全接口');

  // PoW 挑战的 target_path 必须与真实接口一致，否则服务端 POW_HEADER_ERROR
  const challengeCall = calls.find((c) => c.path === '/api/v0/chat/create_pow_challenge');
  assert.deepEqual(JSON.parse(challengeCall.body), { target_path: '/api/v0/chat/completion' });

  // 补全请求：带上 base64 的 PoW header、Bearer token、以及网页端必需的 x-client-*
  const completion = calls.find((c) => c.path === '/api/v0/chat/completion');
  const headers = completion.headers;
  const powHeader = headers['x-ds-pow-response'];
  assert.ok(powHeader, '缺少 x-ds-pow-response');
  const decoded = JSON.parse(Buffer.from(powHeader, 'base64').toString('utf8'));
  assert.equal(decoded.answer, 987654);
  assert.equal(decoded.target_path, '/api/v0/chat/completion');
  assert.match(headers.authorization, /^Bearer tok_/);
  assert.equal(headers['x-client-bundle-id'], 'com.deepseek.chat');
  assert.equal(headers['x-client-platform'], 'web');
  assert.ok(headers['x-client-locale']);
  assert.ok(headers['x-device-id']);

  // 请求体：一次一个会话，prompt 就是全部上下文（与逆向日记一致）
  const body = JSON.parse(completion.body);
  assert.equal(body.chat_session_id, 'sess-1');
  assert.equal(body.parent_message_id, null);
  assert.equal(body.prompt, '# Messages:\n## User\n你好');
  assert.equal(body.thinking_enabled, false);
  assert.deepEqual(body.ref_file_ids, []);

  await engine.close();
});

test('direct: THINK 片段走 reasoning 通道，正文走 content 通道', async (t) => {
  installFetch(t, {
    completion: () =>
      sseRes([
        'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"先想"}]}\n\n',
        'data: {"v":"一下"}\n\n',
        'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"答案"}]}\n\n',
        'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
      ]),
  });
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  const think = [];
  const content = [];
  const result = await engine.chat({
    prompt: 'hi',
    thinking: true,
    onDelta: (d) => content.push(d),
    onThinking: (d) => think.push(d),
  });
  assert.equal(result.text, '答案');
  assert.equal(result.reasoning, '先想一下');
  assert.equal(think.join(''), '先想一下');
  assert.equal(content.join(''), '答案');
  await engine.close();
});

test('direct: 40003 / INVALID_TOKEN 映射成 AuthExpiredError（不能当限流）', async (t) => {
  installFetch(t, { challengeFails: true });
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  await assert.rejects(
    () => engine.chat({ prompt: 'hi' }),
    (err) => {
      assert.equal(err.constructor.name, 'AuthExpiredError');
      assert.match(err.message, /INVALID_TOKEN/);
      return true;
    },
  );
  await engine.close();
});

test('direct: 流里的 rate_limit 提示映射成 RateLimitError', async (t) => {
  installFetch(t, {
    completion: () =>
      sseRes([
        'event: hint\ndata: {"type":"error","content":"请求过于频繁，请稍后再试","finish_reason":"rate_limit_reached"}\n\n',
      ]),
  });
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  await assert.rejects(
    () => engine.chat({ prompt: 'hi' }),
    (err) => {
      assert.equal(err.constructor.name, 'RateLimitError');
      return true;
    },
  );
  await engine.close();
});

test('direct: 只读探活 checkLogin 用 /users/current，不建会话', async (t) => {
  const calls = installFetch(t);
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  const r = await engine.checkLogin();
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.deepEqual(calls.map((c) => c.path), ['/api/v0/users/current']);
  await engine.close();
});

test('direct: 探活遇到 40003 如实报 not ok（体检不能把废号说成好号）', async (t) => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => jsonRes({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null });
  t.after(() => {
    globalThis.fetch = original;
  });
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  const r = await engine.checkLogin();
  assert.equal(r.ok, false);
  assert.equal(r.code, 40003);
  await engine.close();
});

test('direct: reloadTokens 热更新号池，并保留同一个 token 的冷却状态', async () => {
  const engine = new DirectEngine({ config: makeConfig(), logger: makeLogger(), powSolver: makePow() });
  const first = engine.pool.accounts[0];
  first.cooldownUntil = Date.now() + 60_000;
  first.lastError = '限流';

  const OUT = 'tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const applied = engine.reloadTokens([first.token, OUT]);
  assert.equal(applied.changed, true);
  assert.equal(applied.tokens, 2);
  assert.equal(engine.pool.accounts.length, 2);

  const kept = engine.pool.accounts[0];
  assert.equal(kept.token, first.token);
  assert.ok(kept.cooldownUntil > Date.now(), '同一个 token 的冷却时间必须保留');
  assert.equal(kept.lastError, '限流');

  // status 必须如实反映号池（后台「没有可用账号」那个 bug 的根就在这个字段）
  const status = engine.status();
  assert.equal(status.accounts.length, 2);
  assert.equal(status.token, true);
  await engine.close();
});

/* ---------------------------------------------------------------- SSE 解析器 */

test('stream: 裸 data / event: data / BATCH 都能还原成正文', () => {
  const state = createStreamState();
  const parser = createSseParser((payload, event) => {
    if (event === 'hint') return;
    applyPatch(state, payload);
  });
  parser.push(
    'data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"你"}]}\n\n' +
      'data: {"v":"好"}\n\n' +
      'data: {"p":"response/fragments/-1/content","v":"！"}\n\n',
  );
  parser.flush();
  assert.equal(contentOf(state), '你好！');
});

test('stream: isAuthInvalidMessage 只认精确的失效文案', () => {
  assert.equal(isAuthInvalidMessage('INVALID_TOKEN'), true);
  assert.equal(isAuthInvalidMessage('token_expired'), true);
  assert.equal(isAuthInvalidMessage('Authorization Failed (invalid token)'), false);
  assert.equal(isAuthInvalidMessage('rate limit'), false);
});
