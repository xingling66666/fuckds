/**
 * 抓取页面自己发出的 /api/v0/chat/completion 原始 SSE。
 *
 * 为什么需要它：DOM 轮询会漏掉「工具调用 token」——模型输出的
 *   DO:{"name":"exec_shell","args":{...}}
 * 恰好在回答末尾时，网页可能提前判定生成结束、重渲染导致文本回退、
 * 或者流式序列化把还没写完的代码块/文本截断，导致 DO 块丢失。
 *
 * 页面自己请求的补全接口里，模型原始输出一定完整存在（DO token 也在里面），
 * 所以这里用 Playwright 的 page.on('response') + response.text() 抓原始 SSE，
 * 用它的文本作为权威结果；DOM 只负责流式展示。
 *
 * 用法：
 *   const capture = createCompletionCapture(page, { logger });
 *   capture.start();                    // 发送前挂监听
 *   ...DOM 轮询...
 *   const raw = await capture.collect({ timeoutMs }); // { text, reasoning, bodies, complete, hints, rateLimited }
 *   capture.dispose();                  // 必须放进 finally
 */

import {
  applyPatch,
  contentOf,
  createSseParser,
  createStreamState,
  reasoningOf,
} from '../sse/patch.mjs';

/** 页面补全接口路径（真实接口形如 /api/v0/chat/completion?...) */
export const COMPLETION_PATH = '/api/v0/chat/completion';

/** 一个 response 都没看到时，最多再等这么久就返回空，避免拖慢离线/fake 页面测试 */
const NO_RESPONSE_GRACE_MS = 400;

/** collect 等待 body 落地时的轮询颗粒度 */
const POLL_MS = 25;

const DEFAULT_WAIT_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** 匹配补全请求；response 对象/URL 字符串都兼容，出错一律当不匹配 */
function isCompletionResponse(response) {
  try {
    const url = typeof response?.url === 'function' ? response.url() : response?.url;
    return Boolean(url) && String(url).includes(COMPLETION_PATH);
  } catch {
    return false;
  }
}

/**
 * 纯函数：把若干段原始 SSE body 解析成文本。
 *
 * 每段 body 都是一次独立的补全请求。页面在超时/断流/重试时可能发出**多段**请求：
 * 旧实现把每段从空 state 重新解析再把文本 append 起来，等于把「半截回答」和
 * 「完整回答」拼在一起 —— 客户端会看到重复/乱序的内容，raw 与 DOM 的前缀关系也被破坏。
 *
 * 现在的策略是「只选一段最可信的 body」：
 *   1. 优先带 FINISHED 状态的 body（说明这段流是正常收尾的）；
 *   2. 多个完整 body 时取更长的那个，一样长取后到的（页面最近一次重试）；
 *   3. 一个 FINISHED 都没有时，退而求其次取最长的一段（可能是被截断的，complete 会标 false）；
 *   4. 同一 message_id 的重复 body（页面把整段重发）不会叠加成两份。
 *
 * @param {string[]} bodies 每个元素是一整段响应体（response.text() 的结果）
 * @returns {{ text: string, reasoning: string, hints: {type: string, content: string, finishReason: string|null}[], rateLimited: boolean }}
 */
export function parseCompletionBodies(bodies) {
  const analysis = analyzeCompletionBodies(bodies);
  const { text, reasoning, hints, rateLimited } = analysis;
  return { text, reasoning, hints, rateLimited };
}

/**
 * 解析单段 body：新建一份 state 独立解析，并记录是否收到 FINISHED。
 * 返回的是一段 body 的「候选答案」，不跨 body 拼接。
 */
function parseCompletionBody(body) {
  const state = createStreamState();
  const one = { text: '', reasoning: '', status: null, messageId: null, finished: false, hints: [], rateLimited: false };

  const parser = createSseParser((payload, event) => {
    // 限流 / 风控提示走 event: hint，不能抛错，只记录下来交给调用方决定
    if (event === 'hint' && payload && payload.type === 'error') {
      const content = String(payload.content || '网页接口提示错误');
      const finishReason = payload.finish_reason ?? null;
      one.hints.push({ type: 'error', content, finishReason });
      if (finishReason === 'rate_limit_reached' || /频繁|休息/.test(content)) one.rateLimited = true;
      return;
    }
    try {
      applyPatch(state, payload);
    } catch {
      // 坏补丁忽略，不能因为一帧异常丢掉整段
    }
  });

  try {
    parser.push(body);
    parser.flush(); // 最后一帧可能没有结尾空行
  } catch {
    // 解析器本身异常也不能抛
  }

  try {
    one.text = contentOf(state);
    one.reasoning = reasoningOf(state);
    one.status = state.status ?? null;
    one.messageId = state.messageId ?? null;
    one.finished = /^finish/i.test(String(one.status || ''));
  } catch {
    // 同上
  }
  return one;
}

/** 从多段候选里挑一段最可信的（不拼接） */
function pickBestBody(candidates) {
  if (!candidates.length) return null;
  const usable = candidates.filter((one) => one.text || one.reasoning);
  const pool = usable.length ? usable : candidates;
  let best = null;
  for (const one of pool) {
    if (!best) {
      best = one;
      continue;
    }
    // 收到 FINISHED 的一律优先：说明这段流是正常收尾的
    if (one.finished !== best.finished) {
      if (one.finished) best = one;
      continue;
    }
    if (one.finished) {
      // 都完整：页面最近一次请求才是屏幕上那份（从头重发的重复 body 只留一份）
      best = one;
    } else if (one.text.length >= best.text.length) {
      // 都不完整（被截断）：退而求其次取更长的一段
      best = one;
    }
  }
  return best;
}

/** 内部分析：返回选中的那一段 + 汇总 hints / 候选列表，供 collect 判断 complete */
function analyzeCompletionBodies(bodies) {
  const result = { text: '', reasoning: '', hints: [], rateLimited: false, candidates: [], chosen: null };
  if (!Array.isArray(bodies)) return result;

  for (const body of bodies) {
    if (typeof body !== 'string' || !body) continue;
    const one = parseCompletionBody(body);
    result.candidates.push(one);
    result.hints.push(...one.hints);
    if (one.rateLimited) result.rateLimited = true;
  }

  const chosen = pickBestBody(result.candidates);
  result.chosen = chosen;
  if (chosen) {
    result.text = chosen.text;
    result.reasoning = chosen.reasoning;
  }
  return result;
}

/**
 * 给一个页面装上补全流捕获器。
 *
 * @param {import('playwright').Page} page
 * @param {{ logger?: object }} [options]
 */
export function createCompletionCapture(page, { logger } = {}) {
  const log = logger || { debug() {}, warn() {}, error() {} };
  /** @type {{ value: string|null, settled: boolean, failed: boolean, done: Promise<void> }[]} */
  const entries = [];
  let started = false;
  let disposed = false;
  let sawResponse = false;

  const onResponse = (response) => {
    if (disposed || !isCompletionResponse(response)) return;
    sawResponse = true;

    let url = '';
    try {
      url = String(response.url());
    } catch {
      /* ignore */
    }

    const entry = { url, value: null, settled: false, failed: false, done: null };
    entries.push(entry);

    let bodyPromise;
    try {
      bodyPromise = Promise.resolve(response.text());
    } catch (err) {
      bodyPromise = Promise.reject(err);
    }

    entry.done = bodyPromise.then(
      (text) => {
        entry.value = typeof text === 'string' ? text : '';
        entry.settled = true;
        log.debug('已抓到页面原始补全流', { bytes: entry.value.length, responses: entries.length });
      },
      (err) => {
        entry.failed = true;
        entry.settled = true;
        log.warn('读取页面原始补全流失败，继续用 DOM 结果', { error: err?.message });
      },
    );

    log.debug('发现补全请求', { url, responses: entries.length });
  };

  function start() {
    if (started || disposed) return;
    started = true;
    try {
      page.on('response', onResponse);
    } catch (err) {
      log.warn('无法监听页面补全请求，退化为纯 DOM 提取', { error: err?.message });
    }
  }

  /**
   * 等原始流收尾并解析。
   * - 一个 response 都没看到：最多等 NO_RESPONSE_GRACE_MS 就返回空；
   * - 看到了：等所有 body settle（或整体超时），把已经拿到的都解析出来。
   * 任何情况下都不抛错。
   */
  async function collect({ timeoutMs = DEFAULT_WAIT_MS } = {}) {
    start();

    const budget =
      Number.isFinite(timeoutMs) && timeoutMs >= 0 ? Math.floor(timeoutMs) : DEFAULT_WAIT_MS;
    const begun = Date.now();

    if (!sawResponse) {
      const graceUntil = begun + Math.min(NO_RESPONSE_GRACE_MS, budget);
      while (!disposed && !sawResponse && Date.now() < graceUntil) {
        await sleep(Math.min(POLL_MS, graceUntil - Date.now()));
      }
    }

    const deadline = begun + budget;
    let timedOut = false;
    while (!disposed) {
      const pending = entries.filter((entry) => !entry.settled);
      if (!pending.length) break;
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      const left = deadline - Date.now();
      await Promise.race([Promise.all(pending.map((entry) => entry.done)), sleep(Math.min(POLL_MS, left))]);
    }

    const bodies = [];
    let failed = 0;
    for (const entry of entries) {
      if (!entry.settled) failed += 1;
      else if (entry.failed) failed += 1;
      else if (typeof entry.value === 'string') bodies.push(entry.value);
    }

    const analysis = analyzeCompletionBodies(bodies);
    const chosen = analysis.chosen;
    // complete = 「选中的那段 body 明确收到了 FINISHED」且没有还在收的请求。
    // 读失败/超时的其它请求不算数：页面重试后成功的第二段完全可以用。
    const pending = entries.some((entry) => !entry.settled);
    const complete = Boolean(chosen?.finished) && !pending && !timedOut;

    log.debug('原始补全流解析完成', {
      complete,
      responses: entries.length,
      bodies: bodies.length,
      failed,
      chars: analysis.text.length,
      reasoningChars: analysis.reasoning.length,
      hints: analysis.hints.length,
      timedOut,
      status: chosen?.status ?? null,
    });
    if (bodies.length > 1) {
      const distinct = analysis.candidates.filter((one) => one.text || one.reasoning);
      if (distinct.length > 1) {
        log.warn('页面这一轮发出了多段补全请求，只取最完整的一段（不拼接）', {
          bodies: distinct.length,
          picked: chosen ? chosen.text.length : 0,
          sizes: distinct.map((one) => one.text.length),
          finished: distinct.map((one) => one.finished),
        });
      }
    }

    const { text, reasoning, hints, rateLimited } = analysis;
    return {
      text,
      reasoning,
      hints,
      rateLimited,
      bodies,
      complete,
      sawResponse,
      pending,
      failed,
      responses: entries.length,
    };
  }

  /** 页面是否已经发出过补全请求（用于驱动判断「原始流还在不在路上」） */
  function hasResponse() {
    return sawResponse;
  }

  /** 还有几段补全 body 没读完（>0 说明生成可能还没结束） */
  function pendingCount() {
    return entries.filter((entry) => !entry.settled).length;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      page.off('response', onResponse);
    } catch {
      try {
        page.removeListener?.('response', onResponse);
      } catch {
        /* ignore */
      }
    }
  }

  return { start, collect, dispose, hasResponse, pendingCount };
}
