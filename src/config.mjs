import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openConfigStore } from './config-store.mjs';

/**
 * 项目根目录。
 *
 * 源码运行时是 src/ 的上一级；用 `bun build --compile` 打成单文件后，
 * import.meta.dirname 指向内嵌虚拟路径，里面没有 web/dist 这些静态资源，
 * 所以按「哪里有 web/dist 就算根」逐个探测，最后一个候选是可执行文件所在目录。
 */
function resolveRoot() {
  const candidates = [
    path.resolve(import.meta.dirname || '.', '..'),
    path.dirname(process.execPath || process.argv[0] || '.'),
    // 二进制放在 <root>/bin/ 时的常见布局
    path.resolve(path.dirname(process.execPath || '.'), '..'),
    process.cwd(),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'web', 'dist', 'index.html'))) return dir;
    } catch {
      /* 忽略 */
    }
  }
  return candidates[0];
}

const ROOT = resolveRoot();

/* ------------------------------------------------------------------ *
 * 值解析（保持旧行为：空值/非法值尽量回退到默认值）
 * ------------------------------------------------------------------ */
const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const str = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value).trim());

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

/**
 * 解析浏览器视口：`1440x900` / `1440,900` / `1440×900` 都认。
 * 非法值（缺一半、太小、NaN）一律退回默认，别把 Playwright 塞进一个非法 viewport。
 */
const viewportOf = (raw, fallback = DEFAULT_VIEWPORT) => {
  const match = String(raw ?? '').match(/(\d{2,5})\s*[x×,*]\s*(\d{2,5})/i);
  if (!match) return { ...fallback };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!(width >= 320 && height >= 240)) return { ...fallback };
  return { width, height };
};

/** 只保留真正有值的环境变量（undefined 表示「没传」，不能覆盖下层配置） */
function definedValues(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 登录态：环境变量 / SQLite > data/auth.json
 * ------------------------------------------------------------------ */
function readTokenFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = [];
    if (Array.isArray(parsed?.tokens)) list.push(...parsed.tokens);
    if (typeof parsed?.token === 'string') list.push(parsed.token);
    return list.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* 文件不存在或损坏都忽略，交给调用方提示 */
  }
  return [];
}

function resolveTokens(env, authFile) {
  const fromEnv = [];
  for (const key of ['DEEPSEEK_USER_TOKENS', 'DEEPSEEK_USER_TOKEN']) {
    const raw = env[key];
    if (!raw) continue;
    fromEnv.push(
      ...String(raw)
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  const list = fromEnv.length ? fromEnv : readTokenFile(authFile);
  return [...new Set(list)];
}

/* ------------------------------------------------------------------ *
 * ENV_SCHEMA 风格键 → 运行中 config 字段的映射
 *
 * 后台保存配置（admin/routes.mjs）和启动加载（loadConfig）都走这里，
 * 避免「启动解析一套、后台保存又解析一套」。
 * 凡是不能原地热更的字段（HOST / PORT / ENGINE / CONCURRENCY ...）也照样
 * 写进 config：后台/概览能看到新值，真实生效需要重启，由 admin 如实标注。
 * ------------------------------------------------------------------ */
const boolValue = (raw) => {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return /^(1|true|yes|on)$/i.test(text);
};

const intValue = (raw, min = 0) => {
  if (raw === undefined || raw === null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= min ? n : null;
};

const TOOL_DECL_MODES = ['auto', 'full', 'compact'];

const ENV_APPLIERS = {
  DEEPSEEK_SEARCH: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.deepseek.search = value;
  },
  DEFAULT_MODEL: (config, raw) => {
    const value = str(raw);
    if (value) config.deepseek.defaultModel = value;
  },
  LOG_LEVEL: (config, raw) => {
    const value = str(raw).toLowerCase();
    if (value) config.logLevel = value;
  },
  CORS_ORIGIN: (config, raw) => {
    // 允许保存空串（等价于不再允许跨域），和以前的逻辑一致
    if (raw !== undefined && raw !== null) config.server.cors = String(raw).trim();
  },
  PROMPT_STYLE: (config, raw) => {
    const value = str(raw).toLowerCase();
    if (value) config.runtime.promptStyle = value === 'legacy' ? 'legacy' : 'stealth';
  },
  TOOL_DECL_COMPACT_THRESHOLD: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.toolDeclCompactThreshold = value;
  },
  TOOL_DECL_MODE: (config, raw) => {
    const value = str(raw).toLowerCase();
    if (TOOL_DECL_MODES.includes(value)) config.runtime.toolDeclMode = value;
  },
  CONCURRENCY: (config, raw) => {
    const value = intValue(raw, 1);
    if (value !== null) config.runtime.concurrency = value;
  },
  QUEUE_LIMIT: (config, raw) => {
    const value = intValue(raw, 1);
    if (value !== null) config.runtime.queueLimit = value;
  },
  REQUEST_TIMEOUT_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.requestTimeoutMs = value;
  },
  FIRST_TOKEN_TIMEOUT_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.firstTokenTimeoutMs = value;
  },
  MAX_PROMPT_CHARS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.maxPromptChars = value;
  },
  MAX_ATTACHMENT_CHARS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.maxAttachmentChars = value;
  },
  OVERFLOW_TO_ATTACHMENT: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.runtime.overflowToAttachment = value;
  },
  WARMUP: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.runtime.warmup = value;
  },
  SAVE_ARTIFACTS: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.runtime.saveArtifacts = value;
  },
  ACCOUNT_COOLDOWN_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.accountCooldownMs = value;
  },
  DEEPSEEK_PROXIES: (config, raw) => {
    if (raw === undefined || raw === null) return;
    config.deepseek.proxies = String(raw)
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  },
  DEEPSEEK_COOKIES_WARMUP: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.deepseek.cookiesWarmup = value;
  },
  DEEPSEEK_SHUMEI_ID: (config, raw) => {
    const value = str(raw);
    if (value) config.deepseek.shumeiDeviceId = value;
  },
  DEEPSEEK_CLIENT_VERSION: (config, raw) => {
    const value = str(raw);
    if (value) config.deepseek.clientVersion = value;
  },
  DEEPSEEK_LOCALE: (config, raw) => {
    const value = str(raw);
    if (value) config.deepseek.locale = value;
  },
  DEEPSEEK_COLDSTART_DECLARE_DEVICE: (config, raw) => {
    const value = boolValue(raw);
    if (value !== null) config.deepseek.coldStartDeclareDevice = value;
  },
  DEEPSEEK_COLDSTART_REFRESH_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.deepseek.coldStartRefreshMs = value;
  },
  DEEPSEEK_CONVERSATION_TTL_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.deepseek.conversationTtlMs = value;
  },
  DEEPSEEK_SESSION_REUSE: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.deepseek.sessionReuse = value;
  },
  BIG_PROMPT_CHARS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.bigPromptChars = value;
  },
  WINDOW_CHARS_LIMIT: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.windowCharsLimit = value;
  },
  USAGE_THROTTLE_MS: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.usageThrottleMs = value;
  },
  MAX_ACCOUNT_SWITCHES: (config, raw) => {
    const value = intValue(raw, 0);
    if (value !== null) config.runtime.maxAccountSwitches = value;
  },
  HOST: (config, raw) => {
    const value = str(raw);
    if (value) config.server.host = value;
  },
  PORT: (config, raw) => {
    const value = intValue(raw, 1);
    if (value !== null && value <= 65_535) config.server.port = value;
  },
  API_KEY: (config, raw) => {
    // 空串表示清空（后台保存时前端会二次确认）
    if (raw !== undefined && raw !== null) config.server.apiKey = String(raw).trim();
  },
};

/**
 * 把 ENV_SCHEMA 风格的 `{KEY: value}` 原地写进已有 config 对象。
 *
 * - 启动加载时用它叠加 SQLite / 环境变量；
 * - 后台保存时用它让运行中的 config 立即生效（server/engine 都持有同一个对象引用）。
 *
 * 注意：不重新解析 token/auth.json（token 只通过 `loadTokens` / 后台号池接口管理）。
 *
 * @param {object} config loadConfig 返回的对象
 * @param {Record<string, unknown>} updates
 * @returns {string[]} 识别并尝试写入的键
 */
export function applyConfigValues(config, updates = {}) {
  if (!config || typeof config !== 'object') throw new TypeError('applyConfigValues 需要 config 对象');
  const applied = [];
  for (const [key, raw] of Object.entries(updates ?? {})) {
    const applier = ENV_APPLIERS[key];
    if (!applier || raw === undefined || raw === null) continue;
    applier(config, raw);
    applied.push(key);
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * 基础 config：默认值 + 非 ENV_SCHEMA 字段（浏览器特征、运行时细节等）
 *
 * ENV_SCHEMA 里的键这里只放默认值，实际值统一由 applyConfigValues 叠加，
 * 保证「默认 < SQLite < 环境变量」三层优先级只有一套解析。
 * ------------------------------------------------------------------ */
function createBaseConfig(values, { dataDir, authFile }) {
  const tokens = resolveTokens(values, authFile);
  const token = tokens[0] || '';
  const baseUrl = str(values.DEEPSEEK_BASE_URL, 'https://chat.deepseek.com').replace(/\/+$/, '');

  return {
    rootDir: ROOT,
    dataDir,
    authFile,
    dbFile: path.join(dataDir, 'config.db'),
    logLevel: 'info',
    server: {
      host: '127.0.0.1',
      port: 8787,
      apiKey: '',
      cors: '*',
    },
    engine: 'hybrid',
    browser: {
      /** 无头模式（服务器上用 headless；要过验证码时用 --headful / xvfb） */
      headless: bool(values.HEADLESS, true),
      /** Playwright 的 Chromium 可执行文件路径（默认用自带） */
      executablePath: str(values.CHROMIUM_PATH, ''),
      /** 额外启动参数（空格分隔） */
      launchArgs: str(values.BROWSER_ARGS, '--no-sandbox,--disable-dev-shm-usage')
        .split(/[\s,]+/)
        .filter(Boolean),
      depDir: str(values.PLAYWRIGHT_DEPS_DIR, ''),
      slowMo: int(values.BROWSER_SLOW_MO, 0),
      navigationTimeoutMs: int(values.BROWSER_NAV_TIMEOUT_MS, 60_000),
      /**
       * 界面语言：DeepSeek 网页按浏览器 locale 渲染文案。
       * 以前这里没有这个字段，`newContext({ locale: undefined })` 落到 Playwright 的
       * en-US，自动登录 / 发送 / 停止按钮的中文文案匹配全部落空。默认中文，
       * 需要别的语言时用 BROWSER_LOCALE 覆盖。
       */
      locale: str(values.BROWSER_LOCALE, 'zh-CN') || 'zh-CN',
      /**
       * User-Agent：留空 = 启动时按**实际 Chromium 版本**自动生成一个桌面 Chrome UA
       * （保证 UA 里的版本号与 sec-ch-ua 客户端提示自洽，也顺手去掉 HeadlessChrome 标记）。
       * 需要固定指纹时用 BROWSER_USER_AGENT 覆盖。
       */
      userAgent: str(values.BROWSER_USER_AGENT, ''),
      /**
       * 视口：BROWSER_VIEWPORT=`1440x900`；兼容老的 BROWSER_WIDTH / BROWSER_HEIGHT 写法。
       */
      viewport: viewportOf(
        str(values.BROWSER_VIEWPORT, '') ||
          (values.BROWSER_WIDTH && values.BROWSER_HEIGHT
            ? `${values.BROWSER_WIDTH}x${values.BROWSER_HEIGHT}`
            : ''),
        DEFAULT_VIEWPORT,
      ),
    },
    /**
     * 直连引擎（转发通道）的配置。
     *
     * 现在的架构是「登录走浏览器、转发走逆向接口」：对话不再经过 Playwright，
     * 而是直接打 chat.deepseek.com 的内部接口（chat_session/create + create_pow_challenge
     * + chat/completion）。PoW 求解交给 Go 写的 bin/ds-pow（`npm run pow:build` 生成）。
     */
    direct: {
      /** PoW 求解器二进制路径（默认仓库内 bin/ds-pow） */
      powBin: path.resolve(ROOT, expandHome(str(values.DS_POW_BIN, 'bin/ds-pow'))),
    },
    /**
     * 引擎模式：hybrid（默认，登录用 browser + 转发 direct）/ direct（纯直连，不启浏览器）
     * 旧值 browser 已废弃，会被自动降级为 hybrid
     * / direct（全直连，连登录辅助都不用）。
     */
    engine: {
      mode: (() => {
        const raw = str(values.DS_ENGINE, 'hybrid').toLowerCase();
        if (raw === 'direct') return 'direct';
        // browser 已废弃：降级成 hybrid（转发本来就走直连）
        return 'hybrid';
      })(),
    },
    mail: {
      user: str(values.MAIL_USER, ''),
      pass: str(values.MAIL_PASS, ''),
      imapHost: str(values.MAIL_IMAP_HOST, 'imap.gmail.com'),
      imapPort: int(values.MAIL_IMAP_PORT, 993),
      smtpHost: str(values.MAIL_SMTP_HOST, 'smtp.gmail.com'),
      smtpPort: int(values.MAIL_SMTP_PORT, 465),
      from: str(values.MAIL_FROM, str(values.MAIL_USER, '')),
      codeTimeoutMs: int(values.MAIL_CODE_TIMEOUT_MS, 120000),
    },
    login: {
      email: str(values.DS_EMAIL, ''),
      password: str(values.DS_PASSWORD, ''),
    },
    deepseek: {
      baseUrl,
      token,
      tokens,
      /**
       * 原生「深度思考」：默认开启。请求体里 thinking_enabled=true，
       * 服务端把 THINK 片段映射成 reasoning_content（OpenAI）/ thinking（Anthropic）。
       * 可用 DEEPSEEK_THINKING=always|never|auto 覆盖：auto 时按模型别名决定，
       * always/never 强制开关。
       */
      thinking: str(values.DEEPSEEK_THINKING, 'always'),
      search: false,
      // 是否主动把网页上的「深度思考 / 智能搜索」开关拨到请求要求的状态
      manageToggles: bool(values.DEEPSEEK_MANAGE_TOGGLES, true),
      defaultModel: 'deepseek-flash',
      // 设备画像：chrome-win（桌面 Chrome）/ chrome-android（移动 Chrome）。
      // 一旦选定就长期固定，别来回切，否则会被识别成「设备漂移」。
      deviceProfile: str(values.DEEPSEEK_DEVICE_PROFILE, 'chrome-win'),
      // 冷启动序列：拉配置 / 设备校验 / 配置回执，让账号有「网页打开过」的痕迹
      coldStart: bool(values.DEEPSEEK_COLD_START, true),
      // 冷启动补跑周期（毫秒，0 = 只在首次跑）：长期进程要定期补配置回执，
      // 否则服务端看到的是「这台设备只活跃过一次」
      coldStartRefreshMs: int(values.DEEPSEEK_COLDSTART_REFRESH_MS, 30 * 60_000),
      /**
       * 是否在冷启动里调用 /users/auth_token/check_device（**危险动作，默认关闭**）。
       * 这个接口会主动向服务端声明「这台设备要使用这枚 token」，设备与 token 不匹配时
       * 服务端的响应是**吊销 token**（不可逆）。只有设备来源可信（login/synced）才建议开。
       */
      coldStartDeclareDevice: bool(values.DEEPSEEK_COLDSTART_DECLARE_DEVICE, false),
      /**
       * 出口代理列表（逗号/换行/分号分隔）。按账号下标粘性绑定：
       *   账号 #1 → proxies[0]，账号 #2 → proxies[1]，以此类推。
       * 生产环境请保证 代理数 >= 账号数，否则仍会「同 IP 多号」。
       * 支持 http:// / https:// / socks5://，可带 user:pass@。
       */
      proxies: str(values.DEEPSEEK_PROXIES)
        .split(/[\s,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      // 真网页端当前的客户端版本与语言（头里的 x-client-version / x-client-locale）
      clientVersion: str(values.DEEPSEEK_CLIENT_VERSION, '2.8.0'),
      /**
       * 数美设备 id（真机抓包是 `B...==` 形式）。本地 SDK 取不到值时可用它兜底；
       * 注意：该 id 与设备指纹绑定，跨设备硬套属于实验，风控可能不认。
       */
      shumeiDeviceId: str(values.DEEPSEEK_SHUMEI_ID, ''),
      locale: str(values.DEEPSEEK_LOCALE, 'zh_CN'),
      /**
       * 会话复用条数：0 = 每条消息都新建会话（旧行为，会话:消息=1:1，机器人指纹强）；
       * >0 = 同一 chat_session 里最多发 N 条根消息再换新会话（把比例拉向人类）。
       * 注意服务端会保留该会话的消息，模型上下文仍然是「自己拼的 prompt」，不会串味。
       */
      /**
       * 一个会话里最多连续发几轮（续聊）。
       *
       * 默认 8：真人一个对话通常聊很多条，旧实现「每条消息都新开会话」才是异常。
       * 续聊时只发新增消息、parent_message_id 指向上一轮回复 —— 和网页端行为一致。
       * 设为 0 可退回旧行为（每条消息一个新会话，别这么做）。
       */
      sessionReuse: int(values.DEEPSEEK_SESSION_REUSE, 8),
      /** 续聊会话的空闲有效期（毫秒）：超过就重开，避免「昨天的对话今天还在续」 */
      conversationTtlMs: int(values.DEEPSEEK_CONVERSATION_TTL_MS, 30 * 60_000),
      // 行为时序伪装：PoW 耗时不那么快、发送前有输入停顿
      humanTiming: bool(values.DEEPSEEK_HUMAN_TIMING, true),
      /** 冷启动时先 GET 首页收 cookie（浏览器永远带 cookie，直连不带就是最廉价的区分器） */
      cookiesWarmup: bool(values.DEEPSEEK_COOKIES_WARMUP, true),
      modelAliases: {
        'deepseek-flash': { thinking: false },
        'deepseek-v3': { thinking: false },
        'deepseek-web': { thinking: false },
        'deepseek-reasoner': { thinking: true },
        'deepseek-r1': { thinking: true },
      },
    },
    runtime: {
      // CONCURRENCY / QUEUE_LIMIT 在浏览器引擎构造时创建 Semaphore，改完需要重启
      concurrency: 1,
      queueLimit: 64,
      requestTimeoutMs: 240_000,
      pollIntervalMs: int(values.POLL_INTERVAL_MS, 60),
      // 文本稳定多久算生成结束（毫秒）
      settleMs: int(values.SETTLE_MS, 800),
      // 两次发送之间的最小间隔：网页有「发送过于频繁」，但 4s 对单账号自用太保守
      // （多轮 agent 每轮都白等 4s，首字延迟的主要来源之一）。默认 1.2s，
      // 真被提示「发送过于频繁」时用 SEND_INTERVAL_MS 调大即可。
      sendIntervalMs: int(values.SEND_INTERVAL_MS, 1200),
      /** 一次请求内最多换几个账号（换号太勤 = 多号同时被标记） */
      maxAccountSwitches: int(values.MAX_ACCOUNT_SWITCHES, 1),
      /** 单次 prompt 超过这个字符数就告警（线上吊销案例都在 14 万以上） */
      bigPromptChars: int(values.BIG_PROMPT_CHARS, 80_000),
      /** 滚动 1 小时内累计 prompt 字符上限，超了就强制长休 */
      windowCharsLimit: int(values.WINDOW_CHARS_LIMIT, 1_500_000),
      usageThrottleMs: int(values.USAGE_THROTTLE_MS, 120_000),
      // 账号被限流后的冷却时间，以及请求最多愿意等多久
      accountCooldownMs: 60_000,
      maxCooldownWaitMs: int(values.MAX_COOLDOWN_WAIT_MS, 5_000),
      // 首段正文最多等多久思考内容（毫秒），保证 reasoning 一定排在 content 前面
      reasoningHoldMs: int(values.REASONING_HOLD_MS, 900),
      rateLimitBackoffMs: int(values.RATE_LIMIT_BACKOFF_MS, 4000),
      firstTokenTimeoutMs: 90_000,
      idleShutdownMs: int(values.IDLE_SHUTDOWN_MS, 15 * 60_000),
      // 启动时就把浏览器拉起来，省掉第一次请求的 2~3 秒
      warmup: true,
      saveArtifacts: true,
      /**
       * 正文走附件（.txt 上传，输入框只放引导）。
       * 默认关闭：直接填输入框更省一次上传往返；只有输入框塞不下时才靠 overflow 拆附件。
       */
      promptAsAttachment: bool(values.PROMPT_AS_ATTACHMENT, false),
      /**
       * 单次 prompt 上限（字符）；超过就把较早的上下文拆成附件。
       *
       * 默认从 165 万降到 12 万：线上日志显示真正会被吊销 token 的请求，
       * prompt 都在 14~47 万字符（tools 324 个）。真人不可能这样用网页版。
       * 需要跑超大上下文就显式调大，但请知道你在放弃「像人」这件事。
       */
      maxPromptChars: int(values.MAX_PROMPT_CHARS, 120_000),
      // 附件注入：拆分出去的上下文最多多少字符（按 3 字节/字的 UTF-8 也远小于上传上限）
      maxAttachmentChars: 2_000_000,
      // 关掉就恢复旧行为：超长直接 413
      overflowToAttachment: true,
      /**
       * 工具声明形态：
       *   auto（默认） 完整声明放得下就用完整，需要拆分时改用压缩索引
       *   full         始终完整 JSON 声明
       *   compact      始终压缩索引（一行一个工具）
       * 工具声明永远不会被挪进附件，放不下会直接报错。
       */
      toolDeclMode: 'auto',
      /**
       * 提示词风格：stealth（默认）用中性词（capability / action），不出现 tool/工具 字样；
       * legacy 是 ## System / ## Tools 的直白写法。
       * 两种风格教的是同一个输出协议：DSML（网页版原生的 XML 风格调用块）。
       * 线上复盘：prompt 里出现「工具调用/tool_calls/function」更容易被风控盯上。
       */
      promptStyle: str(values.PROMPT_STYLE, 'stealth').toLowerCase() === 'legacy' ? 'legacy' : 'stealth',
      /** 工具数超过它就强制压缩声明（见 chat-runner 注释：这是风控红线，不是性能优化） */
      toolDeclCompactThreshold: int(values.TOOL_DECL_COMPACT_THRESHOLD, 40),
      // 浏览器模式：抓页面自己发出的 /api/v0/chat/completion 原始流，用模型原始输出
      // （含 DO 工具调用 token）作为权威文本，DOM 只负责流式展示。关掉退回纯 DOM 提取。
      // DOM 提前判定结束时，最多再等原始流收尾多久（毫秒），用来补齐被截断的尾部 token
      /** 拟人节奏闸：两次请求最小间隔（毫秒）+ 抖动 */
      minRequestIntervalMs: int(values.DEEPSEEK_MIN_INTERVAL_MS, 0),
      requestJitterMs: int(values.DEEPSEEK_JITTER_MS, 0),
      /** 突发：任意 burstWindowMs 内最多 burstMax 次（默认 60s / 6 次，实测 31s 6 次就被吊销） */
      burstMax: int(values.DEEPSEEK_BURST_MAX, 8),
      burstWindowMs: int(values.DEEPSEEK_BURST_WINDOW_MS, 60_000),
      /** 活跃时段，形如 09:00-23:30；空 = 全天 */
      activeHours: str(values.DEEPSEEK_ACTIVE_HOURS, ''),
      /** 每日上限（0 = 不限） */
      dailyMax: int(values.DEEPSEEK_DAILY_MAX, 300),
    },
  };
}

/**
 * 加载配置。
 *
 * 优先级：内置默认值 < SQLite（$DATA_DIR/config.db）< 传入的 env。
 * 不再有「模块加载时把 .env 灌进 process.env」的副作用：
 * - 老 .env 的值在首次建库时迁移进 SQLite（见 config-store.mjs），之后只读 SQLite；
 * - 测试 / CLI 仍可通过传入 env 覆盖任意同名键（例如 test/helpers/browser.mjs 的 makeConfig）。
 *
 * @param {Record<string, unknown>} [env=process.env]
 * @param {object} [options]
 * @param {false|object} [options.store] false 关闭 SQLite；传对象则复用传入的 store
 * @param {string} [options.rootDir] 仅测试/工具用：首次迁移时找 .env 的根目录
 */
export function loadConfig(env = process.env, options = {}) {
  const envValues = definedValues(env);
  const dataDir = path.resolve(ROOT, expandHome(str(envValues.DATA_DIR, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  const authFile = path.join(dataDir, 'auth.json');

  /** @type {{getAll: Function, dbFile: string}|null} */
  let store = null;
  if (options.store !== false) {
    store =
      options.store && typeof options.store.getAll === 'function'
        ? options.store
        : openConfigStore({ dataDir, rootDir: options.rootDir ?? ROOT });
  }
  const storedValues = store?.getAll?.() ?? {};

  const config = createBaseConfig({ ...storedValues, ...envValues }, { dataDir, authFile });
  // 默认值 < SQLite < 传入 env（分两次原地叠加，非法值会被忽略，保留下层有效值）
  applyConfigValues(config, storedValues);
  applyConfigValues(config, envValues);
  config.store = store;
  return config;
}

export const CONFIG_ROOT = ROOT;
