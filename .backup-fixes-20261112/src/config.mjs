import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { openConfigStore } from './config-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

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
  ENGINE: (config, raw) => {
    const value = str(raw);
    if (value) config.engine = value;
  },
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
    engine: 'direct',
    direct: {
      powBin: path.resolve(ROOT, expandHome(str(values.POW_BIN, 'bin/ds-pow'))),
    },
    deepseek: {
      baseUrl,
      token,
      tokens,
      /**
       * 原生「深度思考」已强制关闭（模型需要推理时写 <think>...</think>）。
       * 保留字段只为兼容旧代码和后台概览展示，DEEPSEEK_THINKING 已不再作为设置项。
       */
      thinking: 'never',
      search: false,
      // 是否主动把网页上的「深度思考 / 智能搜索」开关拨到请求要求的状态
      manageToggles: bool(values.DEEPSEEK_MANAGE_TOGGLES, true),
      defaultModel: 'deepseek-flash',
      // 设备画像：chrome-win（桌面 Chrome）/ chrome-android（移动 Chrome）。
      // 一旦选定就长期固定，别来回切，否则会被识别成「设备漂移」。
      deviceProfile: str(values.DEEPSEEK_DEVICE_PROFILE, 'chrome-win'),
      // 冷启动序列：拉配置 / 设备校验 / 配置回执，让账号有「网页打开过」的痕迹
      coldStart: bool(values.DEEPSEEK_COLD_START, true),
      // 行为时序伪装：PoW 耗时不那么快、发送前有输入停顿
      humanTiming: bool(values.DEEPSEEK_HUMAN_TIMING, true),
      modelAliases: {
        'deepseek-flash': { thinking: false },
        'deepseek-v3': { thinking: false },
        'deepseek-web': { thinking: false },
        'deepseek-reasoner': { thinking: true },
        'deepseek-r1': { thinking: true },
      },
    },
    browser: {
      headless: bool(values.BROWSER_HEADLESS, true),
      executablePath: str(values.CHROMIUM_EXECUTABLE) || '',
      // 无 root 环境下，把 .deb 解包到本地目录，通过 LD_LIBRARY_PATH 供 Chromium 使用
      depsDir: expandHome(str(values.CHROMIUM_DEPS_DIR, path.join(os.homedir(), '.local', 'chromium-deps'))),
      userAgent: str(
        values.BROWSER_USER_AGENT,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
      viewport: {
        width: int(values.BROWSER_WIDTH, 1440),
        height: int(values.BROWSER_HEIGHT, 900),
      },
      locale: str(values.BROWSER_LOCALE, 'zh-CN'),
      slowMo: int(values.BROWSER_SLOW_MO, 0),
      launchArgs: str(values.BROWSER_ARGS)
        .split(/\s+/)
        .filter(Boolean),
      navigationTimeoutMs: int(values.BROWSER_NAV_TIMEOUT_MS, 60_000),
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
      // 直连不做发送间隔（限流是「窗口内条数」，靠号池绕），保留开关以便需要时限制
      directSendIntervalMs: int(values.DIRECT_SEND_INTERVAL_MS, 0),
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
      // 网页输入框单次上限；超过就把较早的上下文拆成附件
      maxPromptChars: 1_650_000,
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
      // 浏览器模式：抓页面自己发出的 /api/v0/chat/completion 原始流，用模型原始输出
      // （含 DO 工具调用 token）作为权威文本，DOM 只负责流式展示。关掉退回纯 DOM 提取。
      browserCapture: bool(values.BROWSER_CAPTURE, true),
      // DOM 提前判定结束时，最多再等原始流收尾多久（毫秒），用来补齐被截断的尾部 token
      browserCaptureWaitMs: int(values.BROWSER_CAPTURE_WAIT_MS, 20_000),
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
