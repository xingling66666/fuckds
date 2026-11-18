import fs from 'node:fs';
import path from 'node:path';
import { loadPlaywright } from './playwright.mjs';

import { installPageHelpers } from './page-scripts.mjs';
import { buildLaunchEnv, resolveChromiumExecutable } from './env.mjs';
import { Semaphore } from './semaphore.mjs';
import { createCompletionCapture } from './stream-capture.mjs';
import {
  ApiError,
  AuthExpiredError,
  CaptchaError,
  PromptTooLongError,
  RateLimitError,
  TimeoutError,
  UpstreamError,
} from '../errors.mjs';
import { commonPrefixLength, sleep } from '../util.mjs';
import { openTokenStore } from '../token-store.mjs';

/**
 * 界面文案候选：网页会跟着 locale 变（中文 UI / 英文 UI 都见过）。
 * 数组里两种语言都要留，否则哪天语言一变，自动化直接抛「找不到按钮」。
 */
const NEW_CHAT_LABELS = [
  '开启新对话',
  '新建对话',
  '新对话',
  'New chat',
  'New Chat',
  'Start new chat',
];
const STOP_LABELS = ['停止生成', '停止', 'Stop generating', 'Stop Generating', 'Stop'];
const SEND_LABELS = ['发送', '发送消息', 'Send message', 'Send'];
/** 深度思考 / 智能搜索开关的两种语言写法 */
const THINKING_LABELS = ['深度思考', 'DeepThink', 'Deep Think', 'Thinking'];
const SEARCH_LABELS = ['智能搜索', '联网搜索', 'Search', 'Web search', 'Web Search'];

/** 后台展示 token 时用的掩码（与 admin 的 maskToken 同形态，前后各留 6 位） */
function maskTokenValue(token) {
  const text = String(token || '');
  if (!text) return '(空)';
  if (text.length <= 12) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 6)}…${text.slice(-6)} (${text.length} 字符)`;
}

/**
 * 按**实际 Chromium 版本**拼一个桌面 Chrome UA。
 *
 * 为什么不用写死的版本号：UA 里的版本和页面能读到的 `sec-ch-ua` 客户端提示
 * 必须自洽，硬编码一个旧版本反而是更明显的破绽。这里用同一个大版本号，
 * 并按当前系统补平台段，同时剥掉 `HeadlessChrome` 标记。
 */
export function desktopUserAgent(version) {
  const major = String(version || '').split('.')[0] || '131';
  const tail = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  if (process.platform === 'win32') return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`;
  if (process.platform === 'darwin') return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  return `Mozilla/5.0 (X11; Linux ${arch}) ${tail}`;
}

/**
 * 页面里的语言兜底：有些站点不看请求头，直接用 `navigator.language` 决定文案，
 * 所以连 JS 可见的字段也一起覆盖。
 */
function installLocale(locale) {
  try {
    Object.defineProperty(navigator, 'language', { get: () => locale, configurable: true });
    Object.defineProperty(navigator, 'languages', {
      get: () => [locale, locale.split('-')[0]],
      configurable: true,
    });
  } catch {
    /* 某些上下文不允许改，忽略 */
  }
}

/**
 * Playwright 驱动 chat.deepseek.com。
 *
 * 设计要点：
 * - 每条请求都从「新对话」开始，绝不复用上一轮的网页状态；
 * - 整个上下文由调用方拼进一条 prompt（见 src/prompt/build.mjs）；
 * - 用轮询 DOM 的方式拿流式输出，不依赖 DeepSeek 的内部接口和 PoW 算法。
 */
export class DeepSeekWeb {
  constructor({ config, logger }) {
    this.config = config;
    this.log = logger;
    this.browser = null;
    this.context = null;
    this.slots = [];
    this.semaphore = new Semaphore(config.runtime.concurrency, config.runtime.queueLimit);
    this.launching = null;
    this.idleTimer = null;
    this.closing = false;
    this.lastSendAt = 0;
    this.cooldownUntil = 0;
    /** 主 token 的调用统计（后台账号表显示用，不参与调度） */
    this.tokenStats = { requests: 0, limited: 0, errors: 0, lastError: null };
    /** 主 token 是否被判为登录态失效（被服务端踢回 /sign_in） */
    this.authFailed = false;
    /** 页内直发传输（懒创建） */
    this.net = null;
  }

  get baseUrl() {
    return this.config.deepseek.baseUrl;
  }

  /**
   * 热切换号池：把新的 token 应用到运行中的浏览器，**不需要重启进程**。
   *
   * 做法：更新 config 里的 token，然后关掉当前浏览器——下一次请求会用新 token
   * 重新创建上下文并注入 localStorage（addInitScript 在 context 创建时生效）。
   */
  reloadTokens(tokens) {
    let list = Array.isArray(tokens) ? tokens.filter(Boolean) : null;
    if (!list) {
      // 后台保存号池 / 换号时只调 web.reloadTokens()：从数据库取当前号池
      try {
        const store = openTokenStore({ dataDir: this.config.dataDir });
        list = store.list().map((row) => row.token);
      } catch {
        list = null;
      }
    }
    const next = list && list.length ? list[list.length - 1] : null;
    const prev = this.config.deepseek.token;
    if (next && next !== prev) {
      this.config.deepseek.token = next;
      this.log?.info?.(`号池已热更新：切换到 ${String(next).slice(0, 6)}…（浏览器将重建）`);
      this.close().catch(() => {});
    }
    return {
      added: next && next !== prev ? 1 : 0,
      removed: 0,
      kept: next === prev ? 1 : 0,
      total: list ? list.length : 1,
    };
  }

  /* ------------------------------------------------------------------ *
   * 生命周期
   * ------------------------------------------------------------------ */

  async ensureStarted() {
    if (this.closing) throw new UpstreamError('服务正在关闭');
    if (this.browser?.isConnected()) return;
    if (this.launching) return this.launching;

    this.launching = this.#launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  async #launch() {
    if (!this.config.deepseek.token) {
      throw new AuthExpiredError(
        '还没有配置 DeepSeek 的 userToken：执行 `npm run auth -- <userToken>`，或设置环境变量 DEEPSEEK_USER_TOKEN',
      );
    }

    const env = buildLaunchEnv(this.config, this.log);
    const executablePath = resolveChromiumExecutable(this.config);
    const locale = this.config.browser.locale || 'zh-CN';
    /**
     * `--lang` 在这里**强制合并**，不依赖用户的 launchArgs / 系统环境：
     * 界面文案一旦变成英文，自动登录和发送按钮的文案匹配就会直接报错。
     * 用户 launchArgs 里自带的 --lang 会被丢掉，统一用配置里的 locale。
     */
    const userArgs = (this.config.browser.launchArgs || []).filter((arg) => !String(arg).startsWith('--lang'));
    const args = [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      ...userArgs,
      `--lang=${locale}`,
    ];

    this.log.info('启动 Chromium…', {
      executable: executablePath ? path.basename(path.dirname(executablePath)) : '(playwright 默认)',
      headless: this.config.browser.headless,
      locale,
    });

    const { chromium } = await loadPlaywright();
    this.browser = await chromium.launch({
      headless: this.config.browser.headless,
      executablePath,
      args,
      env,
      slowMo: this.config.browser.slowMo || undefined,
    });

    this.browser.on('disconnected', () => {
      this.log.warn('Chromium 已断开');
      this.browser = null;
      this.context = null;
    });

    const { viewport } = this.config.browser;
    /** UA：配置里没写就按实际 Chromium 版本自动生成，保证和 sec-ch-ua 自洽 */
    const userAgent = this.config.browser.userAgent || desktopUserAgent(this.browser.version());
    this.context = await this.browser.newContext({
      viewport: viewport || { width: 1440, height: 900 },
      userAgent,
      locale,
      // 请求头也钉死一次：服务端和前端都可能按 Accept-Language 决定返回哪种文案
      extraHTTPHeaders: { 'accept-language': `${locale},${locale.split('-')[0]};q=0.9` },
      timezoneId: process.env.TZ || 'Asia/Shanghai',
      deviceScaleFactor: 1,
    });
    this.log.debug('浏览器上下文已创建', { locale, userAgent, viewport });

    await this.context.addInitScript(installPageHelpers);
    // 页面按 JS 判断语言时也要看到中文（防 navigator.language 兜底识别）
    await this.context.addInitScript(installLocale, locale);
    await this.context.addInitScript(
      ({ token }) => {
        try {
          if (!/(^|\.)deepseek\.com$/.test(location.hostname)) return;
          localStorage.setItem('userToken', JSON.stringify({ value: token, __version: '0' }));
        } catch {
          /* 某些页面禁用 localStorage，忽略 */
        }
      },
      { token: this.config.deepseek.token },
    );

    this.#resetIdleTimer();
  }

  #resetIdleTimer() {
    clearTimeout(this.idleTimer);
    const idle = this.config.runtime.idleShutdownMs;
    if (!idle) return;
    this.idleTimer = setTimeout(() => {
      this.log.info(`空闲 ${Math.round(idle / 1000)}s，关闭浏览器释放内存`);
      this.close().catch(() => {});
    }, idle);
    this.idleTimer.unref?.();
  }

  async close() {
    this.closing = true;
    clearTimeout(this.idleTimer);
    for (const slot of this.slots) {
      await slot.page?.close().catch(() => {});
      slot.page = null;
    }
    this.slots = [];
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
    this.closing = false;
  }

  status() {
    return {
      engine: 'browser',
      browser: Boolean(this.browser?.isConnected()),
      pages: this.slots.filter((s) => s.page && !s.page.isClosed()).length,
      busy: this.slots.filter((s) => s.busy).length,
      queued: this.semaphore.pending,
      token: Boolean(this.config.deepseek.token),
      /**
       * 运行时号池：后台「当前进程里有没有可用账号」就看这个字段。
       * 以前这里没有 accounts，admin 的 `status().accounts ?? []` 永远是空数组，
       * 于是号池明明有 token，后台却一直显示「当前进程里没有可用账号」。
       */
      accounts: this.#accountsStatus(),
    };
  }

  /**
   * 把 `config.deepseek.tokens` 摊成后台账号表要的形状。
   *
   * 字段对齐消费方（web/src/pages/Overview.jsx、Accounts.jsx）：
   * index/token/available/authFailed/requests/limited/errors/cooldownMs/lastError。
   * 当前浏览器引擎只用一个 token 发请求（主 token），其余号的状态保持默认值，
   * 但**每一枚真实存在的 token 都要列出来**，不能凭空隐藏。
   */
  #accountsStatus() {
    const tokens = [];
    const configured = Array.isArray(this.config.deepseek?.tokens) ? this.config.deepseek.tokens : [];
    for (const raw of configured) {
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (value && !tokens.includes(value)) tokens.push(value);
    }
    const primary = this.config.deepseek?.token ? String(this.config.deepseek.token) : '';
    // 主 token 必须在列表第一位：否则后台看到的号和实际发请求的号对不上
    if (primary && tokens[0] !== primary) {
      const rest = tokens.filter((t) => t !== primary);
      tokens.length = 0;
      tokens.push(primary, ...rest);
    }

    const cooldownMs = Math.max(0, (this.cooldownUntil || 0) - Date.now());
    const stats = this.tokenStats;
    return tokens.map((token, i) => {
      const isPrimary = Boolean(primary) && token === primary;
      return {
        index: i + 1,
        token: maskTokenValue(token),
        // 浏览器引擎没有单独的「账号可用性」状态机：没冷却就是可用，被踢下线才置 authFailed
        available: isPrimary ? !this.authFailed : true,
        authFailed: isPrimary ? Boolean(this.authFailed) : false,
        requests: isPrimary ? stats.requests : 0,
        limited: isPrimary ? stats.limited : 0,
        errors: isPrimary ? stats.errors : 0,
        cooldownMs: isPrimary ? cooldownMs : 0,
        lastError: isPrimary ? stats.lastError : null,
      };
    });
  }

  /** 浏览器引擎不支持图片输入（直连引擎才走附件上传） */
  async uploadImages() {
    throw new ApiError(400, '当前引擎不支持图片输入：图片需在网页里手动上传', {
      code: 'image_not_supported',
    });
  }

  /** 浏览器引擎也不支持把超长上下文转附件；只能直连 */
  async uploadAttachments() {
    throw new PromptTooLongError(
      '上下文超过输入框上限：请减少上下文（浏览器里无法自动转附件）',
    );
  }

  /** 预热：把浏览器和第一个页面都建好，第一次请求就不用等导航 */
  async warmUp() {
    await this.ensureStarted();
    const { release } = await this.#acquireSlot();
    release();
  }

  /** 供 `npm run auth` 用：确认 token 能进到对话页 */
  async checkLogin() {
    await this.ensureStarted();
    const { slot, release } = await this.#acquireSlot();
    try {
      const st = await this.#state(slot.page);
      return {
        ok: Boolean(st?.signedIn && st.inputVisible),
        url: st?.url,
        captcha: Boolean(st?.captcha),
      };
    } finally {
      release();
    }
  }

  /* ------------------------------------------------------------------ *
   * 页面池
   * ------------------------------------------------------------------ */

  async #acquireSlot() {
    const release = await this.semaphore.acquire();
    let slot = this.slots.find((s) => !s.busy);
    if (!slot) {
      slot = { page: null, busy: false };
      this.slots.push(slot);
    }

    // 预热点没做完就等它一下，避免它把新请求的输入框/开关重置掉
    for (let i = 0; i < 25 && slot.preWarming; i += 1) await sleep(20);

    slot.busy = true;
    try {
      slot.page = await this.#ensurePage(slot.page);
      return {
        slot,
        release: () => {
          slot.busy = false;
          release();
        },
      };
    } catch (err) {
      slot.busy = false;
      release();
      throw err;
    }
  }

  async #ensurePage(page) {
    if (page && !page.isClosed()) return page;

    if (page) await page.close().catch(() => {});
    if (!this.context) await this.ensureStarted();

    const pageNew = await this.context.newPage();
    pageNew.setDefaultTimeout(30_000);
    pageNew.on('crash', () => this.log.error('页面崩溃'));

    await pageNew.goto(`${this.baseUrl}/`, {
      waitUntil: 'domcontentloaded',
      timeout: this.config.browser.navigationTimeoutMs,
    });
    await this.#waitReady(pageNew);
    return pageNew;
  }

  /** 空闲时先把下一条对话开好，下一次请求就少一次点击等待 */
  #preWarmNextChat(slot) {
    setTimeout(async () => {
      if (slot.busy || !slot.page || slot.page.isClosed()) return;
      slot.preWarming = true;
      try {
        const clicked = await slot.page.evaluate((labels) => window.__DSW__.clickByTexts(labels), NEW_CHAT_LABELS);
        const st = await slot.page.evaluate(() => window.__DSW__.extract());
        this.log.debug('预热新对话', { clicked, assistantCount: st?.assistantCount, url: st?.url });
      } catch {
        /* 预热点失败无所谓 */
      } finally {
        slot.preWarming = false;
      }
    }, 350).unref?.();
  }

  async #dropPage(slot) {
    const page = slot.page;
    slot.page = null;
    if (page) await page.close().catch(() => {});
  }

  /* ------------------------------------------------------------------ *
   * 页面状态读取
   * ------------------------------------------------------------------ */

  async #state(page, options) {
    try {
      return await page.evaluate((opts) => window.__DSW__?.extract?.(opts), options);
    } catch (err) {
      throw new UpstreamError(`读取页面状态失败: ${err.message}`, { code: 'page_eval_failed' });
    }
  }

  async #waitFor(page, predicate, { timeout, label, interval = 150 }) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.#state(page);
      if (predicate(last)) return last;
      await sleep(interval);
    }
    throw new UpstreamError(`等待页面超时：${label}（最后状态 ${JSON.stringify({ url: last?.url })}）`, {
      code: 'ui_timeout',
    });
  }

  async #waitReady(page) {
    const deadline = Date.now() + this.config.browser.navigationTimeoutMs;
    while (Date.now() < deadline) {
      const st = await this.#state(page).catch(() => null);
      if (st?.captcha) throw new CaptchaError('登录页出现人机验证，无法自动完成');
      if (st?.signedIn && st.inputVisible) return;
      if (st && !st.signedIn) {
        /**
         * token 失效时服务端会把人踢到 /sign_in。以前这里只是继续等，
         * 一直磨到 navigationTimeout（60s 起）才报错，客户端那边表现为「请求挂着不返回」。
         * 现在只要看到登录页 URL 就立刻抛 AuthExpiredError。
         */
        const url = page.url();
        if (url.includes('/sign_in') || url.includes('/sign_up')) {
          /**
           * 不再有「真人档案」这条链路（整包 localStorage 导入已砍掉），
           * 所以这里只有一种成因：token 本身失效 / 被风控踢下线。
           */
          throw new AuthExpiredError(
            `被服务端踢回登录页（${url.replace('https://chat.deepseek.com', '')}）：token 已失效或被吊销，` +
              '请重新执行 `npm run auth -- <userToken>`，或在后台「账号」页粘贴新的 userToken',
          );
        }
        await sleep(300);
        continue;
      }
      await sleep(250);
    }
    throw new AuthExpiredError(
      '打开 chat.deepseek.com 后没有进入对话页（可能 token 失效或被风控）。请重新获取 userToken 后执行 `npm run auth`',
    );
  }

  /* ------------------------------------------------------------------ *
   * 对话流程
   * ------------------------------------------------------------------ */

  async chat({ prompt, thinking = false, search = false, signal, onDelta, onThinking, meta = {} }) {
    if (prompt.length > this.config.runtime.maxPromptChars) {
      throw new PromptTooLongError(
        `拼接后的 prompt 有 ${prompt.length} 字符，超过上限 ${this.config.runtime.maxPromptChars}（可用 MAX_PROMPT_CHARS 调整）`,
      );
    }

    await this.ensureStarted();
    this.#resetIdleTimer();

    const attempt = async (n) => {
      const tStart = Date.now();
      const { slot, release } = await this.#acquireSlot();
      const page = slot.page;
      try {
        const tPage = Date.now();
        await this.#prepare(page, { thinking, search });
        const tPrepare = Date.now();
        const result = await this.#run(page, { prompt, signal, onDelta, onThinking, meta });
        result.timings = {
          acquireMs: tPage - tStart,
          prepareMs: tPrepare - tPage,
          ...result.timings,
        };
        this.log.debug('本轮耗时', result.timings);
        this.#resetIdleTimer();
        return result;
      } catch (err) {
        if (!signal?.aborted) await this.#saveArtifact(page, `${meta.id || 'error'}-${n}`);
        await this.#stop(page).catch(() => {});
        await this.#dropPage(slot);
        throw err;
      } finally {
        release();
        if (!signal?.aborted) this.#preWarmNextChat(slot);
      }
    };

    const MAX_ATTEMPTS = 3;
    for (let n = 1; ; n += 1) {
      try {
        const result = await attempt(n);
        this.#recordSuccess();
        return result;
      } catch (err) {
        this.#recordFailure(err);
        if (signal?.aborted) throw err;

        const isRateLimit = err instanceof RateLimitError || err.code === 'deepseek_rate_limited';
        const isTransient =
          err instanceof UpstreamError &&
          !(err instanceof AuthExpiredError) &&
          !(err instanceof CaptchaError) &&
          ['page_eval_failed', 'ui_timeout', 'page_crashed', 'target_closed'].includes(err.code);

        if (n >= MAX_ATTEMPTS || (!isRateLimit && !isTransient)) throw err;

        if (isRateLimit) {
          const wait = this.config.runtime.rateLimitBackoffMs * n;
          this.cooldownUntil = Date.now() + wait;
          this.log.warn(`触发网页频率限制，冷却 ${Math.round(wait / 1000)}s 后重试（第 ${n + 1}/${MAX_ATTEMPTS} 次）`);
        } else {
          this.log.warn(`页面异常，400ms 后重试（第 ${n + 1}/${MAX_ATTEMPTS} 次）`);
          await sleep(400 * n, signal).catch(() => {});
        }
      }
    }
  }

  /** 主 token 的成功统计：后台账号表能看到「请求数」真的在动 */
  #recordSuccess() {
    this.tokenStats.requests += 1;
    this.authFailed = false;
    this.tokenStats.lastError = null;
  }

  /** 失败统计：限流 / 其它错误分开记，登录态失效单独标注 */
  #recordFailure(err) {
    if (err instanceof RateLimitError || err?.code === 'deepseek_rate_limited') {
      this.tokenStats.limited += 1;
    } else {
      this.tokenStats.errors += 1;
    }
    if (err instanceof AuthExpiredError) this.authFailed = true;
    this.tokenStats.lastError = String(err?.message || err || '').slice(0, 200) || null;
  }

  async #prepare(page, { thinking, search }) {
    let st = await this.#state(page);

    if (!st.signedIn) {
      throw new AuthExpiredError('DeepSeek 登录态已失效，请重新执行 `npm run auth -- <userToken>`');
    }

    if (!st.inputVisible) {
      await page.goto(`${this.baseUrl}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.browser.navigationTimeoutMs,
      });
      await this.#waitReady(page);
      st = await this.#state(page);
    }

    // 每条消息都从全新对话开始
    const tNewChat = Date.now();
    if (st.assistantCount > 0) {
      await this.#startNewChat(page);
    }
    const tNewChatDone = Date.now();

    // 网页会记住上次的开关状态，这里强制对齐请求意图（默认关掉联网搜索，保证速度）
    // 页面语言会变：中文 UI 是「深度思考 / 智能搜索」，英文 UI 是 DeepThink / Search，两种都试
    await this.#maybeToggle(page, THINKING_LABELS, Boolean(thinking));
    await this.#maybeToggle(page, SEARCH_LABELS, Boolean(search));

    this.log.debug('prepare 分解', {
      newChatMs: tNewChatDone - tNewChat,
      togglesMs: Date.now() - tNewChatDone,
    });
  }

  async #startNewChat(page) {
    const clicked = await page.evaluate((labels) => window.__DSW__.clickByTexts(labels), NEW_CHAT_LABELS);
    this.log.debug('开始新对话', { clicked });

    if (!clicked) {
      await page.goto(`${this.baseUrl}/`, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.browser.navigationTimeoutMs,
      });
      await this.#waitReady(page);
    }

    await this.#waitFor(page, (st) => st.assistantCount === 0 && st.inputVisible, {
      timeout: 20_000,
      label: '新对话未就绪',
      interval: 60,
    });
    await sleep(40);
  }

  /**
   * 网页上的「深度思考 / 智能搜索」是 .ds-toggle-button，选中态是
   * .ds-toggle-button--selected。状态不一致才点，点完等一小会儿让 UI 生效。
   */
  async #maybeToggle(page, label, desired) {
    if (!this.config.deepseek.manageToggles) return;
    try {
      // 开关是异步渲染的：新对话刚切过去时可能还没出现，先等它挂上再点
      await page
        .waitForFunction(
          (labels) =>
            [...document.querySelectorAll('.ds-toggle-button')].some((el) => {
              const text = el.textContent || '';
              return (Array.isArray(labels) ? labels : [labels]).some((item) => text.includes(item));
            }),
          Array.isArray(label) ? label : [label],
          { timeout: 5_000 },
        )
        .catch(() => {});
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await page.evaluate((text) => window.__DSW__.toggleState(text), label);
        if (!state?.found) {
          const diag = await page
            .evaluate(() => ({
              url: location.href,
              count: document.querySelectorAll('.ds-toggle-button').length,
              texts: [...document.querySelectorAll('.ds-toggle-button')].map((el) => (el.textContent || '').trim().slice(0, 12)),
            }))
            .catch(() => null);
          this.log.debug(`没有找到开关「${label}」，跳过`, diag);
          return;
        }
        if (state.selected === Boolean(desired)) {
          if (attempt > 0) this.log.debug(`开关「${label}」已切到 ${desired ? '开' : '关'}`);
          return;
        }
        const clicked = await page.evaluate((text) => window.__DSW__.clickToggle(text), label);
        if (!clicked) return;
        this.log.debug(`开关 ${label} -> ${desired ? '开' : '关'}`);
        await sleep(120);
      }
      this.log.warn(`开关「${label}」没能切到 ${desired ? '开' : '关'}，继续执行`);
    } catch (err) {
      this.log.debug(`切换 ${label} 失败（忽略）:`, err.message);
    }
  }

  async #typeAndSend(page, prompt) {
    // 账号级限流：两次发送之间至少隔 SEND_INTERVAL_MS，命中限流后还要等冷却
    const now = Date.now();
    const wait = Math.max(
      (this.lastSendAt || 0) + this.config.runtime.sendIntervalMs - now,
      this.cooldownUntil - now,
    );
    if (wait > 0) {
      this.log.debug(`等待发送窗口 ${Math.round(wait / 100) / 10}s`);
      await sleep(wait);
    }

    const focused = await page.evaluate(() => window.__DSW__.focusInput());
    if (!focused) throw new UpstreamError('找不到输入框（页面结构可能变了）', { code: 'ui_not_ready' });

    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.insertText(prompt);

    const outgoing = prompt;

    const expected = Math.min(outgoing.length, 32);
    await page
      .waitForFunction(
        (min) => {
          const el = document.querySelector('textarea');
          return Boolean(el) && (el.value || '').length >= min;
        },
        Math.max(1, expected),
        { timeout: 30_000 },
      )
      .catch(async () => {
        // 极端情况下 insertText 没生效，退回 fill
        const ok = await page.evaluate(() => window.__DSW__.focusInput());
        if (ok) await page.keyboard.insertText(prompt);
      });

    const before = await this.#state(page);
    // 优先真实点击发送按钮（CDP 鼠标 → isTrusted=true）；点完确认没发出去才退 Enter
    const clicked = await this.#clickSendButton(page);
    if (clicked) {
      await sleep(700);
      const st = await this.#state(page).catch(() => null);
      const stillTyped = Boolean(st?.inputValue && st.inputValue.trim());
      const notStarted = !st || st.assistantCount <= before.assistantCount;
      if (stillTyped && notStarted) {
        this.log.debug('点击发送没生效，退回 Enter');
        await page.keyboard.press('Enter');
      }
    } else {
      this.log.debug('没找到发送按钮，退回 Enter');
      await page.keyboard.press('Enter');
    }
    this.lastSendAt = Date.now();

    const sent = await this.#confirmSent(page, before);
    if (!sent) throw new UpstreamError('消息未能发送（可能触发风控或输入过长）', { code: 'send_failed' });
  }

  /** 真实点击发送按钮：先按角色，再按 aria-label / 图标容器找 */
  async #clickSendButton(page) {
    const box = await page
      .evaluate((labels) => {
        const textok = (el) => {
          const t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.textContent || '';
          return labels.some((l) => String(t).trim() === l || String(t).includes(l));
        };
        const nodes = [...document.querySelectorAll('button,[role=button],div.ds-button,[class*=send]')];
        const cand = nodes.filter((el) => el.offsetParent !== null && textok(el));
        for (const el of cand) {
          const r = el.getBoundingClientRect();
          if (r.width > 8 && r.height > 8) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        // 退化：输入框右下角的圆形按钮
        const ta = document.querySelector('textarea');
        if (ta) {
          const r = ta.getBoundingClientRect();
          return { x: r.x + r.width - 28, y: r.y + r.height - 28, guess: true };
        }
        return null;
      }, SEND_LABELS)
      .catch(() => null);
    if (!box) return false;
    await page.mouse.move(box.x - 40, box.y - 26);
    await page.waitForTimeout(60 + Math.random() * 60);
    await page.mouse.move(box.x - 8, box.y - 5);
    await page.waitForTimeout(40 + Math.random() * 50);
    await page.mouse.click(box.x, box.y);
    return true;
  }

  /** 开一个临时页面（登录自动化用；用完自己 close） */
  async newPage() {
    await this.ensureStarted();
    const page = await this.context.newPage();
    page.setDefaultTimeout(30_000);
    return page;
  }

  /** 探活：打开页面看登录态是否还在（后台「体检」用，只读） */
  async probe() {
    try {
      const r = await this.checkLogin();
      return { alive: Boolean(r.ok), code: r.ok ? 0 : 40003, msg: r.ok ? '' : `被踢回登录页（${r.url || 'sign_in'}）` };
    } catch (err) {
      return { alive: false, code: null, msg: err.message };
    }
  }

  async #confirmSent(page, before) {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const st = await this.#state(page).catch(() => null);
      if (!st) return false;
      if (st.captcha) throw new CaptchaError();
      if (st.rateLimited) throw new RateLimitError();
      if (st.assistantCount > before.assistantCount) return true;
      if (!st.inputValue.trim()) return true;
      if (st.notice && /过长|too long|failed|失败/i.test(st.notice)) {
        throw new UpstreamError(`发送失败：${st.notice}`, { code: 'send_failed' });
      }

      // 兜底：点一次发送按钮
      if (Date.now() > deadline - 15_000) {
        await this.#clickSendButton(page).catch(() => {});
      }
      await sleep(60);
    }
    return false;
  }

  /**
   * 一轮对话的调度：
   *   1. 发送前挂上原始补全流捕获（页面自己请求的 /api/v0/chat/completion）；
   *   2. DOM 轮询只负责流式展示；
   *   3. 等页面自己那个补全请求真正收尾（response body settle），再补一次最终 DOM 读取；
   *   4. 用最终 DOM 的前缀扩展补发尾部（page-scripts 保证流式序列化前缀稳定），
   *      再用模型原始输出（含末尾 DO 工具调用 token）作为权威文本；
   *   5. 原始流和 DOM 都拿不到、且页面没有确认生成结束时，宁可显式报错也不返回截断内容。
   */
  async #run(page, { prompt, signal, onDelta, onThinking }) {
    const startedAt = Date.now();
    const runtime = this.config.runtime;
    const captureEnabled = runtime.browserCapture !== false;
    const requestDeadline = startedAt + runtime.requestTimeoutMs;

    let capture = null;
    if (captureEnabled) {
      capture = createCompletionCapture(page, { logger: this.log });
      capture.start();
    }

    let captureResult = null;
    let captureMs = 0;
    /** DOM 轮询是否抛错（此时 DOM 文本不能当作「生成已结束」的证据） */
    let domPollFailed = false;

    // DOM 轮询的中间状态：即使 DOM 循环抛错，也能用这里记录的部分成果做救生艇判断
    const progress = {
      emittedAnswer: '',
      emittedThinking: '',
      sentAt: 0,
      firstDeltaAt: 0,
      lastDeltaAt: 0,
      url: null,
    };

    try {
      let dom = null;
      try {
        dom = await this.#pollDom(page, {
          startedAt,
          prompt,
          signal,
          onDelta,
          onThinking,
          progress,
          capture,
        });
      } catch (err) {
        // 救生艇：DOM 卡住/提前结束/读不到，但原始补全流可能已经拿到内容 → 用原始文本返回
        if (!capture || !isRescuableDomError(err)) throw err;
        domPollFailed = true;

        this.log.warn('DOM 读取中断，等待页面原始补全流收尾', {
          error: err.message,
          code: err.code,
          emittedChars: progress.emittedAnswer.length,
        });
        const tCapture = Date.now();
        captureResult = await capture.collect({
          timeoutMs: Math.max(runtime.browserCaptureWaitMs, Math.min(requestDeadline - Date.now(), 90_000)),
        });
        captureMs = Date.now() - tCapture;

        if (captureResult.rateLimited && !captureResult.text) {
          throw new RateLimitError(captureHintMessage(captureResult) || undefined);
        }
        // 原始流完全没有内容、也没看到补全请求：保留原始错误（登录失效/超时等语义更准确）
        if (!captureResult.text && !captureResult.reasoning && !captureResult.sawResponse) throw err;
        // 放弃 DOM 后把页面上的生成停掉，避免它和下一次请求抢页面状态
        await this.#stop(page).catch(() => {});
      }

      const domConfident = Boolean(dom && (dom.endReason === 'answerComplete' || dom.endReason === 'stopHidden'));
      const captureWaitMs = runtime.browserCaptureWaitMs;

      if (!captureResult && capture) {
        const tCapture = Date.now();
        // 轮询期间只要原始流还在收就不会按「文本稳定」提前 break，所以这里等一个固定预算即可：
        // 正常情况 body 已经 settle，collect 立刻返回；只有页面重试/超时才可能用满预算。
        captureResult = await capture.collect({ timeoutMs: captureWaitMs });
        captureMs = Date.now() - tCapture;
      }

      const rawComplete = captureResult?.complete === true;
      const captureUnreliable = captureEnabled && captureResult?.sawResponse === true && !rawComplete;

      // 生成已经结束：补一次「非流式」DOM 读取。此时页面渲染已落盘，
      // page-scripts 的流式→非流式切换只会追加收尾结构，所以它一定以已发文本为前缀。
      const remaining = Math.max(0, requestDeadline - Date.now());
      const readRounds = rawComplete || domConfident ? 2 : Math.max(2, Math.min(6, Math.ceil(remaining / 200)));
      const finalDom = await this.#readDomTail(page, { rounds: readRounds, signal });
      if (finalDom) {
        dom = dom || { text: '', reasoning: '', timings: null };
        dom.text = longestText(dom.text || '', finalDom.answer);
        dom.reasoning = longestText(dom.reasoning || '', finalDom.thinking);
        if (finalDom.url) progress.url = finalDom.url;
      }
      const generationEnded =
        rawComplete ||
        domConfident ||
        Boolean(finalDom?.answerComplete) ||
        // DOM 轮询是正常结束（不是超时/崩溃）时，最终读取「文本稳定 + 停止按钮消失」才算生成结束；
        // 轮询已经抛错说明 DOM 不可信，只有 answerComplete / 原始流完整才算数。
        Boolean(!domPollFailed && finalDom?.stable && !finalDom.stopVisible);

      // 原始流没有收完整（读失败/超时）而页面也没确认生成结束：不能把可能截断的文本当成功返回
      if (captureUnreliable && !generationEnded) {
        this.log.warn('原始补全流未收完整且 DOM 未确认生成结束，拒绝返回可能截断的内容', {
          emittedChars: progress.emittedAnswer.length,
          domChars: dom?.text?.length ?? 0,
          rawChars: captureResult?.text?.length ?? 0,
          bodies: captureResult?.bodies?.length ?? 0,
          captureMs,
        });
        throw new UpstreamError(
          `页面原始补全流没有收完整（已发出 ${progress.emittedAnswer.length} 字），页面也没有确认生成结束；为避免返回被截断的回答，本次请求按失败处理`,
          { code: 'stream_incomplete' },
        );
      }

      const rawText = captureResult?.text || '';
      const rawReasoning = captureResult?.reasoning || '';
      const domText = longestText(dom?.text || '', progress.emittedAnswer);
      const domReasoning = longestText(dom?.reasoning || '', progress.emittedThinking);

      if (!rawText && !rawReasoning && captureResult?.rateLimited) {
        throw new RateLimitError(captureHintMessage(captureResult) || undefined);
      }
      if (!rawText && !rawReasoning && !domText && !domReasoning) {
        throw new UpstreamError('页面没有返回任何内容', { code: 'empty_response' });
      }
      if (captureUnreliable) {
        this.log.warn('页面原始补全流未收完整，退回 DOM 结果', {
          emittedChars: progress.emittedAnswer.length,
          domChars: domText.length,
          rawChars: rawText.length,
          bodies: captureResult?.bodies?.length ?? 0,
          captureMs,
        });
      } else if (captureEnabled && captureResult && !captureResult.sawResponse) {
        this.log.warn('没有抓到页面补全请求，只能用 DOM 结果', {
          domChars: domText.length,
          capturedMs: captureMs,
        });
      }

      // 先把最终 DOM 的尾巴发出去（page-scripts 保证前缀稳定，emitDelta 不会重复）
      progress.emittedAnswer = emitDelta(progress.emittedAnswer, domText, onDelta, this.log);
      progress.emittedThinking = emitDelta(progress.emittedThinking, domReasoning, onThinking, this.log);

      // 原始流 / DOM 谁更完整：优先「包含对方」的那份；分叉时完整抓到的 raw 优先
      const text = pickAuthoritativeText(rawText, domText, rawComplete);
      const reasoning = pickAuthoritativeText(rawReasoning, domReasoning, rawComplete);

      // 原始流比 DOM 多出来的尾巴：只在严格前缀兼容时补发（工具调用 token 通常在段尾巴里）。
      // 前缀不兼容说明 DOM 的 markdown 序列化与原始文本分叉了，这里不硬拼——
      // 由 chat-runner 在收尾时用权威文本做一次对齐补发（避免重复文本）。
      if (
        text.length > progress.emittedAnswer.length &&
        text.startsWith(progress.emittedAnswer)
      ) {
        onDelta?.(text.slice(progress.emittedAnswer.length));
        progress.emittedAnswer = text;
      }
      if (
        reasoning.length > progress.emittedThinking.length &&
        reasoning.startsWith(progress.emittedThinking)
      ) {
        onThinking?.(reasoning.slice(progress.emittedThinking.length));
        progress.emittedThinking = reasoning;
      }

      if (rawText && domText && rawText !== domText) {
        this.log.debug('DOM 文本与原始补全流不一致，以原始补全流为准', {
          domChars: domText.length,
          rawChars: rawText.length,
        });
      }
      if (rawReasoning && domReasoning && rawReasoning !== domReasoning) {
        this.log.debug('DOM 思考与原始补全流不一致，以原始补全流为准', {
          domReasoningChars: domReasoning.length,
          rawReasoningChars: rawReasoning.length,
        });
      }

      const timings = {
        ...(dom?.timings || {
          sendMs: progress.sentAt ? progress.sentAt - startedAt : null,
          firstTokenMs:
            progress.firstDeltaAt && progress.sentAt ? progress.firstDeltaAt - progress.sentAt : null,
          streamMs:
            progress.firstDeltaAt && progress.lastDeltaAt
              ? progress.lastDeltaAt - progress.firstDeltaAt
              : null,
          totalMs: Date.now() - startedAt,
        }),
        captureMs,
        captureBodies: captureResult?.bodies?.length ?? 0,
        captureResponses: captureResult?.responses ?? 0,
        captureFailedBodies: captureResult?.failed ?? 0,
        captureComplete: rawComplete,
        captureSawResponse: Boolean(captureResult?.sawResponse),
        domChars: domText.length,
        rawChars: rawText.length,
        endReason: dom?.endReason ?? null,
      };

      return {
        timings,
        text,
        reasoning,
        streamed: progress.emittedAnswer,
        streamedReasoning: progress.emittedThinking,
        elapsedMs: Date.now() - startedAt,
        url: dom?.url ?? progress.url ?? undefined,
        finishedAt: Date.now(),
        // 网页可能把思考块折叠掉，流式期间拿到的才是完整的
        reasoningTruncated: Boolean(progress.emittedThinking) && !reasoning,
      };
    } finally {
      capture?.dispose();
    }
  }

  /**
   * 生成结束后补读 DOM：多轮读取、只保留最长版本，并在「文本不再变化 + 生成结束迹象」时提前收手。
   * 返回 { answer, thinking, answerComplete, stopVisible, stable, url }。
   */
  async #readDomTail(page, { rounds = 2, intervalMs = 200, signal } = {}) {
    let best = null;
    let previous = null;
    for (let i = 0; i < rounds; i += 1) {
      const st = await this.#state(page, { streaming: false }).catch(() => null);
      if (st) {
        best = best || { answer: '', thinking: '', answerComplete: false, stopVisible: false, stable: false, url: null };
        best.answer = longestText(best.answer, st.answer || '');
        best.thinking = longestText(best.thinking, st.thinking || '');
        best.answerComplete = best.answerComplete || Boolean(st.answerComplete);
        best.stopVisible = Boolean(st.stopVisible);
        best.url = st.url || best.url;
        if (previous !== null && previous === best.answer && (best.answerComplete || !best.stopVisible)) {
          best.stable = true;
          break;
        }
        previous = best.answer;
      }
      if (i < rounds - 1) await sleep(intervalMs, signal).catch(() => {});
    }
    return best;
  }

  /** 纯 DOM 轮询：负责流式展示，并记录「只增不减」的最长文本版本 */
  async #pollDom(page, { startedAt, prompt, signal, onDelta, onThinking, progress, capture }) {
    const { pollIntervalMs, settleMs, firstTokenTimeoutMs, requestTimeoutMs } = this.config.runtime;
    // 原始补全流还在收、但 DOM 长时间不再变化时的兜底上限：超过就结束轮询，交给 capture 补齐
    const captureStallMs = Math.max(settleMs * 10, 30_000);

    await this.#typeAndSend(page, prompt);
    const sentAt = Date.now();
    progress.sentAt = sentAt;

    let firstDeltaAt = 0;
    let lastDeltaAt = 0;

    // DOM 文本永不缩水：网页重渲染/折叠会让文本回退，记住历史上最长的版本
    let bestAnswer = '';
    let bestThinking = '';
    let lastThinking = '';
    let lastChange = Date.now();
    let sawStop = false;
    let sawAnything = false;
    let sawReasoning = false;
    let firstAnswerAt = 0;
    let finalState = null;
    /** 结束原因：answerComplete / stopHidden / settle / captureStalled，用于判断 DOM 是否可信 */
    let endReason = 'settle';

    const deadline = startedAt + requestTimeoutMs;

    for (;;) {
      if (signal?.aborted) {
        await this.#stop(page);
        throw new UpstreamError('客户端已断开，已停止生成', { status: 499, code: 'client_closed' });
      }
      if (Date.now() > deadline) {
        await this.#stop(page);
        throw new TimeoutError(`等待回答超过 ${Math.round(requestTimeoutMs / 1000)}s`);
      }

      const st = await this.#state(page, { streaming: true });
      finalState = st;
      progress.url = st.url;

      if (st.captcha) throw new CaptchaError();
      if (st.rateLimited) throw new RateLimitError();
      if (st.notice) {
        if (/过长|too long/i.test(st.notice)) throw new PromptTooLongError(st.notice);
        if (/正在生成|稍后再试|still generating|try again later/i.test(st.notice)) {
          throw new UpstreamError(`页面提示：${st.notice}`, { code: 'page_busy' });
        }
      }

      bestAnswer = longestText(bestAnswer, st.answer);
      bestThinking = longestText(bestThinking, st.thinking);

      // 先发思考、再发正文：网页的思考块是「思考结束」才挂进 DOM 的，
      // 如果先发正文，客户端会把思考块渲染到回答中间去。
      if (bestThinking && bestThinking !== lastThinking) {
        lastThinking = bestThinking;
        progress.emittedThinking = emitDelta(progress.emittedThinking, bestThinking, onThinking, this.log);
        lastChange = Date.now();
        sawAnything = true;
        sawReasoning = true;
      }

      const currentAnswer = bestAnswer || st.answer;
      if (currentAnswer && currentAnswer !== progress.emittedAnswer) {
        const now = Date.now();
        if (!firstAnswerAt) firstAnswerAt = now;
        // 页面里已经有思考块但内容还没出现时，压住正文等一小会儿
        const holding = !sawReasoning && st.hasThink && now - firstAnswerAt < this.config.runtime.reasoningHoldMs;

        if (holding) {
          lastChange = now;
        } else {
          const next = emitDelta(progress.emittedAnswer, currentAnswer, onDelta, this.log);
          if (next !== progress.emittedAnswer) {
            progress.emittedAnswer = next;
            lastChange = Date.now();
            sawAnything = true;
          }
        }
      }

      if (st.stopVisible) sawStop = true;

      const idleFor = Date.now() - lastChange;
      const hasAnswer = bestAnswer.length > 0;

      if (!firstDeltaAt && (progress.emittedAnswer || progress.emittedThinking)) firstDeltaAt = Date.now();
      if (progress.emittedAnswer || progress.emittedThinking) lastDeltaAt = Date.now();
      progress.firstDeltaAt = firstDeltaAt;
      progress.lastDeltaAt = lastDeltaAt;

      if (hasAnswer && st.answerComplete && idleFor >= 150) {
        endReason = 'answerComplete';
        break;
      }
      if (hasAnswer && sawStop && !st.stopVisible && idleFor >= 200) {
        endReason = 'stopHidden';
        break;
      }
      if (hasAnswer && !st.stopVisible && idleFor >= settleMs) {
        // 原始补全流还在收（body 没 settle）说明生成其实没结束：模型停顿、停止按钮识别失败
        // 都可能让 DOM 看起来「稳定」。此时继续轮询，宁可多跑几轮也要让流完整。
        const captureInFlight = Boolean(capture?.hasResponse?.()) && (capture?.pendingCount?.() ?? 0) > 0;
        if (!captureInFlight) {
          endReason = 'settle';
          break;
        }
        if (idleFor >= captureStallMs) {
          this.log.warn('DOM 文本长时间不再变化但页面补全流仍未收尾，先结束轮询并等待原始流补齐', {
            idleForMs: idleFor,
            emittedChars: progress.emittedAnswer.length,
          });
          endReason = 'captureStalled';
          break;
        }
      }

      if (!sawAnything && Date.now() - startedAt > firstTokenTimeoutMs) {
        throw new TimeoutError(`等待首字超过 ${Math.round(firstTokenTimeoutMs / 1000)}s`);
      }
      if (!hasAnswer && !bestThinking && Date.now() - lastChange > 60_000) {
        throw new TimeoutError('DeepSeek 长时间没有输出');
      }

      await sleep(pollIntervalMs, signal).catch(() => {});
      if (signal?.aborted) continue;
    }

    // 收尾：再读一次，补齐最后一次增量
    await sleep(150, signal).catch(() => {});
    let end = await this.#state(page, { streaming: false }).catch(() => finalState);
    if (end?.answer) bestAnswer = longestText(bestAnswer, end.answer);
    if (end?.thinking) bestThinking = longestText(bestThinking, end.thinking);

    // final read 比记录过的更短（文本回退/思考折叠）时重试几次，始终保留最长版本
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answerShrank = Boolean(bestAnswer) && (!end?.answer || end.answer.length < bestAnswer.length);
      const thinkingShrank = Boolean(bestThinking) && (!end?.thinking || end.thinking.length < bestThinking.length);
      if (!answerShrank && !thinkingShrank) break;
      await sleep(120, signal).catch(() => {});
      const again = await this.#state(page, { streaming: false }).catch(() => null);
      if (!again) break;
      end = again;
      if (again.answer) bestAnswer = longestText(bestAnswer, again.answer);
      if (again.thinking) bestThinking = longestText(bestThinking, again.thinking);
    }
    if (end?.url) progress.url = end.url;

    // best 里还没流出去的尾巴补发一次（正常情况 emitted 已经等于 best）
    if (bestAnswer && bestAnswer.length > progress.emittedAnswer.length && bestAnswer.startsWith(progress.emittedAnswer)) {
      onDelta?.(bestAnswer.slice(progress.emittedAnswer.length));
      progress.emittedAnswer = bestAnswer;
    }
    if (
      bestThinking.length > progress.emittedThinking.length &&
      bestThinking.startsWith(progress.emittedThinking)
    ) {
      onThinking?.(bestThinking.slice(progress.emittedThinking.length));
      progress.emittedThinking = bestThinking;
    }

    const text = bestAnswer || end?.answer || progress.emittedAnswer;
    const reasoning = bestThinking || end?.thinking || progress.emittedThinking;

    return {
      timings: {
        sendMs: sentAt - startedAt,
        firstTokenMs: firstDeltaAt ? firstDeltaAt - sentAt : null,
        streamMs: firstDeltaAt && lastDeltaAt ? lastDeltaAt - firstDeltaAt : null,
        totalMs: Date.now() - startedAt,
      },
      text,
      reasoning,
      endReason,
      answerComplete: Boolean(end?.answerComplete),
      stopVisible: Boolean(end?.stopVisible),
      streamed: progress.emittedAnswer,
      streamedReasoning: progress.emittedThinking,
      elapsedMs: Date.now() - startedAt,
      url: end?.url,
      finishedAt: Date.now(),
      // 网页可能把思考块折叠掉，流式期间拿到的才是完整的
      reasoningTruncated: Boolean(progress.emittedThinking) && !reasoning,
    };
  }

  async #stop(page) {
    try {
      await page.evaluate((labels) => window.__DSW__.clickByTexts(labels), STOP_LABELS);
    } catch {
      /* 页面可能已经关闭 */
    }
  }

  async #saveArtifact(page, tag) {
    if (!this.config.runtime.saveArtifacts) return;
    try {
      if (!page || page.isClosed()) return;
      const dir = path.join(this.config.dataDir, 'artifacts');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${String(tag).replace(/[^\w.-]/g, '_')}.png`);
      await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
      this.log.debug('已保存现场截图', file);
    } catch {
      /* 截图失败无所谓 */
    }
  }
}

/**
 * 只在「新内容以旧内容为前缀」时输出增量。
 * 网页重渲染偶尔会让文本回退，这时宁可不输出，等它长回来。
 */
function emitDelta(previous, current, callback, logger) {
  if (!current || current === previous) return previous;
  if (current.startsWith(previous)) {
    const delta = current.slice(previous.length);
    if (delta) callback?.(delta);
    return current;
  }
  const lcp = commonPrefixLength(previous, current);
  logger?.debug('流式文本不连续，跳过本次增量', { lcp, prev: previous.length, next: current.length });
  return previous;
}

/**
 * 原始补全流 vs DOM 文本，取更可信的一份。
 * - raw 以 dom 为前缀且更长：DOM 被截断/提前结束 → 用 raw（工具调用 token 常在 raw 末尾）
 * - dom 以 raw 为前缀且更长：原始流没抓完整 → 用 dom，别把已经拿到的尾巴丢掉
 * - 两边分叉（渲染格式差异）：完整抓到的 raw 优先，否则取更长的一方
 */
function pickAuthoritativeText(raw, dom, rawComplete) {
  if (!raw) return dom;
  if (!dom) return raw;
  if (raw === dom) return raw;
  if (raw.startsWith(dom)) return raw;
  if (dom.startsWith(raw)) return dom;
  if (rawComplete) return raw;
  return dom.length > raw.length ? dom : raw;
}

/**
 * DOM 文本永不缩水：只接受更长的版本。
 * 回退（变短）说明页面在重渲染/折叠，此时旧的长版本才是完整的。
 */
function longestText(current, next) {
  if (!next) return current;
  if (!current) return next;
  return next.length > current.length ? next : current;
}

/**
 * DOM 循环里哪些异常允许用原始补全流兜底。
 * 登录失效 / 验证码 / 限流 / prompt 过长 / 客户端断开必须继续抛。
 */
function isRescuableDomError(err) {
  if (!err) return false;
  if (err instanceof AuthExpiredError || err instanceof CaptchaError) return false;
  if (err instanceof RateLimitError || err instanceof PromptTooLongError) return false;
  if (err.code === 'client_closed') return false;
  if (err instanceof TimeoutError) return true;
  return err instanceof UpstreamError && ['page_eval_failed', 'ui_timeout'].includes(err.code);
}

/** 从原始流的 hint 里取一条可读的错误提示 */
function captureHintMessage(captureResult) {
  const hint = captureResult?.hints?.find((entry) => entry?.content);
  return hint?.content || '';
}
