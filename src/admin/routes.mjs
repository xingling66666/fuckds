import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ApiError } from '../errors.mjs';
import { escapeHtml, readJsonBody, requireApiKey, sendHtml, sendJson } from '../http.mjs';
import {
  loadTokenRecords,
  loadTokens,
  maskToken,
  normalizeUserToken,
  saveTokens,
  splitTokenCandidates,
} from '../auth.mjs';
import { applyConfigValues } from '../config.mjs';
import { getTokenMeta } from '../token-meta.mjs';
import { openConfigStore } from '../config-store.mjs';
import { openTokenStore, POOLS } from '../token-store.mjs';
import { AutoRegister } from '../register/auto.mjs';
import { loadPlaywright } from '../browser/playwright.mjs';
import { describeProxy } from '../register/proxy.mjs';
import { startDeviceCode, pollDeviceCode, clearTokenCache, resolveOAuthClient, OAUTH_PRESETS } from '../mail/oauth.mjs';
import { testMailbox } from '../mail/diagnose.mjs';
import { PROFILES } from '../register/fingerprint.mjs';

/** 编译进二进制的后台静态资源（scripts/embed-web.mjs 生成；源码模式下可以为空） */
let embeddedWeb = { getWebAsset: () => null, count: 0 };
try {
  const mod = await import('./web-assets.generated.mjs');
  embeddedWeb = { getWebAsset: mod.getWebAsset, count: mod.WEB_ASSET_COUNT ?? 0 };
} catch {
  /* 没生成过就用磁盘上的 web/dist */
}
import { loginWithBrowser, persistLogin } from '../browser/login.mjs';

/** 自动登录会话（单例） */
let autoLogin = null;
import { createEngine } from '../engine.mjs';
import { modelsResponse } from '../openai/response.mjs';

/**
 * 后台管理接口 + 静态页面托管。
 *
 * 设计目标：把所有「要开终端敲命令」的日常操作搬到网页上——
 * 看状态、换 token（号池）、校验登录态、试调用、看日志、改配置、重启。
 *
 * 安全边界：
 * - 静态页面本身不敏感，可以公开；
 * - /admin/api/* 在配置了 API_KEY 时要求同样的 key，否则只依赖 HOST 是回环地址
 *   （和服务本体的鉴权策略一致，默认 127.0.0.1 只监听本机）。
 */

/**
 * 允许在后台里修改的配置项。
 *
 * 保存后会写入 SQLite（data/config.db）并**原地热更**运行中的 config，
 * 只有 restartKeys 里的项需要重启进程（监听地址 / 端口 / 引擎实例 / 浏览器信号量 / 启动预热）。
 */
const ENV_SCHEMA = [
  { key: 'DEEPSEEK_SEARCH', label: '智能搜索', type: 'boolean', help: '让网页版默认打开「智能搜索」（即时生效）' },
  { key: 'DEFAULT_MODEL', label: '默认模型名', type: 'text', help: '请求没写 model 时使用的名字（即时生效）' },
  { key: 'LOG_LEVEL', label: '日志级别', type: 'select', options: ['error', 'warn', 'info', 'debug', 'trace'], help: '即时生效' },
  { key: 'CONCURRENCY', label: '并发数', type: 'number', min: 1, max: 64, help: '浏览器信号量在启动时创建，修改后需重启' },
  { key: 'QUEUE_LIMIT', label: '排队上限', type: 'number', min: 1, max: 4096, help: '浏览器信号量在启动时创建，修改后需重启' },
  { key: 'REQUEST_TIMEOUT_MS', label: '单次超时（毫秒）', type: 'number', min: 1000, help: '即时生效' },
  { key: 'FIRST_TOKEN_TIMEOUT_MS', label: '首字超时（毫秒）', type: 'number', min: 1000, help: '即时生效' },
  { key: 'MAX_PROMPT_CHARS', label: '输入框上限（字符）', type: 'number', min: 1000, help: '即时生效' },
  { key: 'MAX_ATTACHMENT_CHARS', label: '附件上限（字符）', type: 'number', min: 1000, help: '即时生效' },
  { key: 'OVERFLOW_TO_ATTACHMENT', label: '超长转附件', type: 'boolean', help: '关掉后超长上下文直接返回 413（即时生效）' },
  { key: 'TOOL_DECL_MODE', label: '工具声明形态', type: 'select', options: ['auto', 'full', 'compact'], help: 'auto 放得下就用完整声明；full 始终完整；compact 始终压缩（即时生效）' },
  { key: 'WARMUP', label: '启动时预热', type: 'boolean', help: '只在进程启动时执行，修改后需重启' },
  { key: 'SAVE_ARTIFACTS', label: '保存调试产物', type: 'boolean', help: '即时生效' },
  { key: 'ACCOUNT_COOLDOWN_MS', label: '限流冷却（毫秒）', type: 'number', min: 1000, help: '即时生效' },
  { key: 'CORS_ORIGIN', label: '跨域来源', type: 'text', help: 'Access-Control-Allow-Origin，* 表示允许所有（即时生效）' },
  { key: 'HOST', label: '监听地址', type: 'text', help: '改完重启才生效，建议保持 127.0.0.1' },
  { key: 'PORT', label: '监听端口', type: 'number', min: 1, max: 65535, help: '改完重启才生效' },
  { key: 'API_KEY', label: 'API Key', type: 'password', help: '设置后 API 和后台接口都会要求鉴权，留空表示不鉴权（即时生效）' },
];

/** 真正必须重启才能生效的键：监听 socket / 引擎实例 / 浏览器信号量 / 启动预热都是构造时决定的 */
const RESTART_KEYS = ['HOST', 'PORT', 'CONCURRENCY', 'QUEUE_LIMIT', 'WARMUP'];

/** GET 时 API_KEY 不回显真实值，PUT 时收到这个占位符表示「没改」 */
const MASKED_API_KEY = '••••••••';

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_TOKENS_PER_REQUEST = 32;

export function createAdminHandler({ config, logger, web }) {
  const log = logger.child('admin');
  const rootDir = config.rootDir;
  const distDir = path.join(rootDir, 'web', 'dist');
  const authFile = config.authFile;
  const serverLog = path.join(config.dataDir, 'server.log');
  const ctlScript = path.join(rootDir, 'scripts', 'server-ctl.mjs');

  /** 自动注册（无需 VNC、IMAP 收码、可定时）：懒加载并启动调度器 */
  let autoRegister = null;
  const getAutoRegister = () => {
    if (!autoRegister) {
      configStore();
      // 注册链路只认「解题号池」：那一池的号只用来答无障碍题，不做任何业务请求
      autoRegister = new AutoRegister({
        config,
        logger,
        engine: createEngine({ config, logger, pool: 'solver' }),
        // 注册成功后把「主池」重新灌进运行中的引擎，避免「池里有号却要重启」
        onTokenAdded: () => reloadMainPool(),
      });
      autoRegister.startScheduler();
    }
    return autoRegister;
  };

  /** 配置存储是 SQLite；loadConfig 默认挂到 config.store 上，这里兼容手工构造的 config */
  function configStore() {
    if (!config.store) {
      config.store = openConfigStore({ dataDir: config.dataDir, rootDir });
      config.dbFile = config.store.dbFile;
    }
    return config.store;
  }

  function configDbFile() {
    return config.dbFile ?? config.store?.dbFile ?? path.join(config.dataDir, 'config.db');
  }

  /** 同一时间只跑一批 token 校验，避免把账号打爆 */
  let verifying = false;

  /** @returns {Promise<boolean>} 是否已经处理（false 交给上层 404） */
  return async function handleAdmin(req, res, url) {
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

    if (url.pathname === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      res.end();
      return true;
    }

    if (url.pathname.startsWith('/admin/api/')) {
      requireApiKey(req, config, { message: '需要 API Key' });
      try {
        await handleApi(req, res, url);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : new ApiError(500, err.message);
        if (!(err instanceof ApiError)) log.error('后台接口失败:', err);
        sendJson(res, apiError.status, { error: { message: apiError.message, status: apiError.status } });
      }
      return true;
    }

    serveStatic(req, res, url);
    return true;
  };

  /* ------------------------------------------------------------------ *
   * API
   * ------------------------------------------------------------------ */

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /admin/api/overview') {
      return sendJson(res, 200, buildOverview());
    }

    /* ---- 自动注册（无需 VNC） ---- */

    if (route === 'GET /admin/api/register/auto') {
      const auto = getAutoRegister();
      return sendJson(res, 200, {
        ok: true,
        settings: auto.maskedSettings(),
        status: auto.status(),
        schedulerRunning: auto.schedulerRunning(),
        fingerprints: PROFILES.map((p) => ({ id: p.id, label: p.label, kind: p.kind })),
        oauthPresets: Object.entries(OAUTH_PRESETS).map(([id, v]) => ({ id, label: v.label, clientId: v.clientId })),
      });
    }

    if (route === 'POST /admin/api/register/auto/config') {
      const body = await readJsonBody(req, 64 * 1024);
      const auto = getAutoRegister();
      const saved = auto.saveSettings(body || {});
      return sendJson(res, 200, { ok: true, ...saved, status: auto.status() });
    }

    if (route === 'POST /admin/api/register/auto/run') {
      const body = await readJsonBody(req, 64 * 1024).catch(() => ({}));
      const auto = getAutoRegister();
      if (auto.running) return sendJson(res, 409, { ok: false, error: '已有注册任务在进行', status: auto.status() });
      // 后台跑，接口立刻返回，前端轮询 status
      auto
        .runOnce({
          email: body?.email || '',
          password: body?.password || '',
          mode: body?.mode === 'manual' ? 'manual' : 'auto',
        })
        .catch((err) => log.error('自动注册失败:', err));
      return sendJson(res, 200, { ok: true, started: true, status: auto.status() });
    }

    if (route === 'POST /admin/api/register/auto/code') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const auto = getAutoRegister();
      const r = auto.submitCode(body?.code);
      if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error, status: auto.status() });
      return sendJson(res, 200, { ok: true, code: r.code, status: auto.status() });
    }

    if (route === 'POST /admin/api/register/auto/scheduler') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const auto = getAutoRegister();
      if (body?.enabled !== undefined) auto.saveSettings({ enabled: Boolean(body.enabled) });
      if (body?.enabled) auto.startScheduler();
      return sendJson(res, 200, { ok: true, schedulerRunning: auto.schedulerRunning(), status: auto.status() });
    }

    /* ---- 邮箱 OAuth（微软个人账户没有应用密码了） ---- */

    if (route === 'POST /admin/api/mail/oauth/start') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const auto = getAutoRegister();
      const s = auto.settings();
      const resolved = resolveOAuthClient({
        preset: body?.preset || s.oauthPreset,
        clientId: body?.clientId || s.oauthClientId,
        tenant: body?.tenant || s.oauthTenant,
      });
      const { clientId, tenant } = resolved;
      try {
        const code = await startDeviceCode({ clientId, tenant, scope: s.oauthScope });
        return sendJson(res, 200, { ok: true, ...code, clientId, tenant });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (route === 'POST /admin/api/mail/oauth/poll') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const auto = getAutoRegister();
      const s = auto.settings();
      const resolved = resolveOAuthClient({
        preset: body?.preset || s.oauthPreset,
        clientId: body?.clientId || s.oauthClientId,
        tenant: body?.tenant || s.oauthTenant,
      });
      const { clientId, tenant } = resolved;
      const deviceCode = String(body?.deviceCode || '');
      if (!clientId || !deviceCode) return sendJson(res, 400, { ok: false, error: '缺少 client_id 或 device_code' });
      try {
        const r = await pollDeviceCode({ clientId, tenant, deviceCode, scope: s.oauthScope });
        if (r.pending) return sendJson(res, 200, { ok: true, pending: true, slowDown: Boolean(r.slowDown) });
        // 成功：把 refresh_token 落库，并切到 oauth 模式
        auto.saveSettings({
          imapAuthMode: 'oauth',
          oauthPreset: resolved.preset,
          oauthClientId: resolved.preset === 'custom' ? clientId : '',
          oauthTenant: tenant,
          oauthRefreshToken: r.tokens.refreshToken,
        });
        clearTokenCache({ clientId, user: s.imapUser });
        return sendJson(res, 200, {
          ok: true,
          pending: false,
          expiresAt: r.tokens.expiresAt,
          hasRefreshToken: Boolean(r.tokens.refreshToken),
          settings: auto.maskedSettings(),
        });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
    }

    if (route === 'GET /admin/api/register/next-email') {
      const auto = getAutoRegister();
      return sendJson(res, 200, auto.previewEmail());
    }

    if (route === 'POST /admin/api/mail/test') {
      const auto = getAutoRegister();
      const s = auto.settings();
      const cfg = {
        user: s.imapUser,
        pass: s.imapPass,
        imap: { host: s.imapHost || 'outlook.office365.com', port: s.imapPort || 993, secure: true, mailbox: s.mailbox || 'INBOX' },
        oauth: {
          enabled: s.imapAuthMode === 'oauth',
          clientId: resolveOAuthClient({ preset: s.oauthPreset, clientId: s.oauthClientId, tenant: s.oauthTenant }).clientId,
          tenant: s.oauthTenant || 'consumers',
          refreshToken: s.oauthRefreshToken,
          scope: s.oauthScope,
        },
      };
      const r = await testMailbox(cfg, (m) => log.info('[mail-test]', m));
      return sendJson(res, 200, r);
    }

    if (route === 'GET /admin/api/mail/oauth/status') {
      const auto = getAutoRegister();
      const s = auto.settings();
      return sendJson(res, 200, {
        ok: true,
        authMode: s.imapAuthMode,
        clientId: s.oauthClientId,
        tenant: s.oauthTenant,
        hasRefreshToken: Boolean(s.oauthRefreshToken),
        ready: s.imapAuthMode === 'oauth' ? Boolean(s.imapUser && s.oauthClientId && s.oauthRefreshToken) : Boolean(s.imapUser && s.imapPass),
      });
    }

    if (route === 'POST /admin/api/register/auto/stop') {
      const auto = getAutoRegister();
      await auto.stop();
      return sendJson(res, 200, { ok: true, status: auto.status() });
    }

    if (route === 'POST /admin/api/login') {
      if (autoLogin?.state === 'running') return sendJson(res, 409, { ok: false, error: '已有登录任务在进行' });
      const body = await readJsonBody(req, 64 * 1024);
      const email = String(body.email || config.login?.email || '').trim();
      const password = String(body.password || config.login?.password || '');
      if (!email || !password) return sendJson(res, 400, { ok: false, error: '缺少邮箱或密码（DS_EMAIL / DS_PASSWORD）' });

      autoLogin = { state: 'running', startedAt: Date.now(), error: '', result: null, page: null };
      (async () => {
        let page;
        try {
          page = await web.newPage();
          autoLogin.page = page;
          const out = await loginWithBrowser(page, {
            email,
            password,
            log: (m) => logger.info(`[login] ${m}`),
            mail: {
              user: config.mail?.user || '',
              pass: config.mail?.pass || '',
              imap: { host: config.mail?.imapHost, port: config.mail?.imapPort, secure: true, mailbox: 'INBOX' },
              smtp: { host: config.mail?.smtpHost, port: config.mail?.smtpPort, secure: true },
              from: config.mail?.from || config.mail?.user || '',
              codeTimeoutMs: config.mail?.codeTimeoutMs || 120000,
              codeRegex: '(?<!\\d)(\\d{6})(?!\\d)',
            },
          });
          persistLogin({ config, ...out });
          // 自动登录只产出一个新 token：要**追加**进号池（addTokens），
          // 不能 reloadTokens —— 那是"整池替换"，会把池里其它还活着的号一起丢掉。
          if (typeof web.addTokens === 'function') web.addTokens([out.token]);
          else if (typeof web.reloadTokens === 'function') web.reloadTokens([out.token]);
          autoLogin.state = 'ok';
          autoLogin.result = { token: `${out.token.slice(0, 8)}…`, deviceId: out.deviceId || null };
        } catch (err) {
          autoLogin.state = 'error';
          autoLogin.error = err.message;
          logger.warn(`[login] 失败: ${err.message}`);
        } finally {
          await page?.close().catch(() => {});
          autoLogin.page = null;
        }
      })();
      return sendJson(res, 202, { ok: true, state: 'running' });
    }

    if (route === 'GET /admin/api/login/status') {
      if (!autoLogin) return sendJson(res, 200, { ok: true, state: 'idle' });
      return sendJson(res, 200, {
        ok: autoLogin.state !== 'error',
        state: autoLogin.state,
        startedAt: autoLogin.startedAt,
        error: autoLogin.error || null,
        result: autoLogin.result,
      });
    }

    if (route === 'GET /admin/api/login/screenshot') {
      if (!autoLogin?.page) return sendJson(res, 404, { ok: false, error: '没有进行中的登录' });
      const buf = await autoLogin.page.screenshot().catch(() => null);
      if (!buf) return sendJson(res, 404, { ok: false, error: '截图失败' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': buf.length });
      return res.end(buf);
    }

    if (route === 'POST /admin/api/login/cancel') {
      if (autoLogin?.page) await autoLogin.page.close().catch(() => {});
      if (autoLogin) autoLogin.state = 'cancelled';
      return sendJson(res, 200, { ok: true, state: autoLogin?.state || 'idle' });
    }

    if (route === 'GET /admin/api/accounts') {
      return sendJson(res, 200, buildAccounts());
    }

    if (route === 'POST /admin/api/accounts/verify') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, await verifyTokens(body.tokens));
    }

    if (route === 'POST /admin/api/accounts') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, saveAccounts(body));
    }

    if (route === 'POST /admin/api/accounts/revoke') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const store = tokenStoreSafe();
      if (!store) throw new ApiError(500, '号池数据库不可用');
      const token = resolveTokenByIndex(store, body);
      const reason = String(body?.reason || '手动标记');
      store.markRevoked(token, reason);
      reloadMainPool();
      return sendJson(res, 200, { ok: true, token: maskToken(token), poolCounts: store.counts() });
    }

    if (route === 'POST /admin/api/accounts/restore') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      const store = tokenStoreSafe();
      if (!store) throw new ApiError(500, '号池数据库不可用');
      const token = resolveTokenByIndex(store, body);
      store.markOk(token);
      reloadMainPool();
      return sendJson(res, 200, { ok: true, token: maskToken(token), poolCounts: store.counts() });
    }

    if (route === 'POST /admin/api/accounts/pool') {
      const body = await readJsonBody(req, 64 * 1024);
      return sendJson(res, 200, moveAccount(body));
    }

    if (route === 'POST /admin/api/accounts/remove') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, removeAccount(body));
    }

    if (route === 'POST /admin/api/proxy/test') {
      const body = await readJsonBody(req, 16 * 1024).catch(() => ({}));
      return sendJson(res, 200, await testProxy(body?.proxy));
    }

    if (route === 'GET /admin/api/diagnostics') {
      sendJson(res, 200, await buildDiagnostics());
      return;
    }
    if (route === 'POST /admin/api/doctor') {
      sendJson(res, 200, await runDoctor());
      return;
    }
    if (route === 'GET /admin/api/config') {
      return sendJson(res, 200, buildConfig());
    }

    if (route === 'PUT /admin/api/config') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, saveConfig(body));
    }

    if (route === 'GET /admin/api/logs') {
      const lines = clampInt(url.searchParams.get('lines'), 50, 5000, 300);
      return sendJson(res, 200, readLogTail(lines));
    }

    if (route === 'POST /admin/api/restart') {
      return sendJson(res, 200, await restartServer());
    }

    throw new ApiError(404, `未知接口: ${route}`, { code: 'not_found' });
  }

  /**
   * 诊断面板：把「为什么可能被封」这件事摊开给你看。
   * 数据全部来自运行中的引擎，不额外发请求（除了 doctor 按钮）。
   */
  async function buildDiagnostics() {
    const status = web.status();
    const records = loadTokenRecords(config);
    return {
      ok: true,
      now: new Date().toISOString(),
      engine: status.engine,
      exits: (config.deepseek.proxies || []).length ? config.deepseek.proxies.map(String) : ['本机 IP（同 IP 多号是高危形态）'],
      usageShape: status.usageShape ?? null,
      pacing: status.pacing ?? null,
      accounts: (status.accounts ?? []).map((a, i) => ({
        ...a,
        deviceSource: a.deviceSource ?? records[i]?.source ?? 'unknown',
        revokedCount: getTokenMeta(config.dataDir, records[i]?.token || '').revokedCount || 0,
      })),
      config: {
        sessionReuse: config.deepseek.sessionReuse,
        sessionTtlMs: config.deepseek.conversationTtlMs,
        maxPromptChars: config.runtime.maxPromptChars,
        toolDeclCompactThreshold: config.runtime.toolDeclCompactThreshold,
        bigPromptChars: config.runtime.bigPromptChars,
        windowCharsLimit: config.runtime.windowCharsLimit,
        coldStartDeclareDevice: config.deepseek.coldStartDeclareDevice,
      },
    };
  }

  /** 手动体检：逐个 token 探活（只读接口，不会触发风控动作） */
  async function runDoctor() {
    if (verifying) throw new ApiError(409, '已有校验任务在进行，请稍后再试');
    verifying = true;
    try {
      const records = loadTokenRecords(config);
      const results = [];
      for (const row of records) {
        // 浏览器探活：用当前登录态打开首页，看是否被踢回 /sign_in
        const health = await web.probe().catch((err) => ({ alive: false, code: null, msg: err.message }));
        const meta = getTokenMeta(config.dataDir, row.token);
        results.push({
          token: maskToken(row.token),
          deviceId: row.deviceId || null,
          source: row.source || meta.source || null,
          revokedCount: meta.revokedCount || 0,
          alive: health.alive,
          code: health.code ?? null,
          msg: health.msg || '',
        });
      }
      return { ok: results.every((r) => r.alive), results };
    } finally {
      verifying = false;
    }
  }

  function buildOverview() {
    const status = web.status();
    const saved = loadTokens(config);
    const models = modelsResponse().data.map((m) => m.id);
    return {
      ok: true,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      now: new Date().toISOString(),
      ...status,
      models,
      savedTokens: saved.map(maskToken),
      savedCount: saved.length,
      config: {
        host: config.server.host,
        port: config.server.port,
        engine: 'direct',
        browserTransport: config.runtime.browserTransport,
        thinking: config.deepseek.thinking,
        search: config.deepseek.search,
        concurrency: config.runtime.concurrency,
        queueLimit: config.runtime.queueLimit,
        requestTimeoutMs: config.runtime.requestTimeoutMs,
        maxPromptChars: config.runtime.maxPromptChars,
        overflowToAttachment: config.runtime.overflowToAttachment,
        warmup: config.runtime.warmup,
        logLevel: config.logLevel,
        apiKeySet: Boolean(config.server.apiKey),
        deviceProfile: config.deepseek.deviceProfile,
        // 反封相关（后台要能看到，不然改了配置也不知道生效没）
        clientVersion: config.deepseek.clientVersion,
        locale: config.deepseek.locale,
        sessionReuse: config.deepseek.sessionReuse,
        conversationTtlMs: config.deepseek.conversationTtlMs,
        coldStart: config.deepseek.coldStart,
        coldStartDeclareDevice: config.deepseek.coldStartDeclareDevice,
        maxPromptCharsEffective: config.runtime.maxPromptChars,
        toolDeclCompactThreshold: config.runtime.toolDeclCompactThreshold,
        bigPromptChars: config.runtime.bigPromptChars,
        windowCharsLimit: config.runtime.windowCharsLimit,
        maxAccountSwitches: config.runtime.maxAccountSwitches,
      },
      files: {
        authFile,
        logFile: serverLog,
        // 配置持久化已从 .env 改为 SQLite；envFile 保留为兼容别名（指向同一个 db 文件）
        configDb: configDbFile(),
        envFile: configDbFile(),
        dataDir: config.dataDir,
        distDir,
        distBuilt: fs.existsSync(path.join(distDir, 'index.html')),
      },
      node: process.version,
    };
  }

  function tokenStoreSafe() {
    try {
      return openTokenStore({ dataDir: config.dataDir });
    } catch {
      return null;
    }
  }

  /** 把主池重新灌进运行中的引擎（改池/加号后调用） */
  function reloadMainPool() {
    const store = tokenStoreSafe();
    if (!store) return null;
    const main = store
      .list('main')
      .filter((r) => (r.status || 'ok') !== 'revoked')
      .map((r) => r.token)
      .filter(Boolean);
    if (typeof web?.reloadTokens === 'function') return web.reloadTokens(main, { allowEmpty: true });
    return null;
  }

  /**
   * 测代理：真起一个无头 Chromium 走这个代理访问 ipinfo，
   * 这样 http / socks5 都能测（Node 原生 fetch 不支持代理，undici 又不支持 socks5）。
   */
  async function testProxy(raw) {
    const info = describeProxy(raw);
    if (!info.proxy) return { ok: false, error: '代理为空' };
    const t0 = Date.now();
    const { chromium } = await loadPlaywright();
    let browser = null;
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: info.proxy },
        args: ['--no-sandbox'],
      });
      const page = await browser.newPage();
      await page.goto('https://ipinfo.io/json', { timeout: 25_000, waitUntil: 'domcontentloaded' });
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      const data = JSON.parse(body);
      return {
        ok: true,
        ms: Date.now() - t0,
        proxy: info.proxy,
        scheme: info.scheme,
        warning: info.warning,
        ip: data.ip,
        country: data.country,
        city: data.city,
        org: data.org,
      };
    } catch (err) {
      return {
        ok: false,
        ms: Date.now() - t0,
        proxy: info.proxy,
        scheme: info.scheme,
        warning: info.warning,
        error: `连不上：${err.message.split('\n')[0]}`,
      };
    } finally {
      await browser?.close().catch(() => {});
    }
  }

  /** 按「完整 token」或「列表序号」定位一枚 token */
  function resolveTokenByIndex(store, body) {
    let token = String(body?.token || '').trim();
    if (token && store.get(token)) return token;
    const index = Number.parseInt(body?.index, 10);
    const shown = loadTokenRecords(config);
    const list = shown.length ? shown : store.list();
    if (!Number.isFinite(index) || index < 1 || index > list.length) {
      throw new ApiError(400, `序号不合法：${body?.index}（当前列表 ${list.length} 个）`);
    }
    return list[index - 1].token;
  }

  function buildAccounts() {
    const status = web.status();
    const saved = loadTokens(config);
    const store = tokenStoreSafe();
    const poolMap = new Map();
    let counts = { main: 0, solver: 0 };
    try {
      for (const row of store?.list() || []) poolMap.set(row.token, row.pool || 'main');
      // 上面 poolMap 只存池名；状态直接从记录里读
      counts = store?.counts?.() || counts;
    } catch {}
    let savedAt = null;
    try {
      savedAt = JSON.parse(fs.readFileSync(authFile, 'utf8')).savedAt ?? null;
    } catch {
      savedAt = null;
    }
    // 保留完整字段（status/revoked* 也要，否则界面上的「已吊销」永远是 ok）
    const records = loadTokenRecords(config);
    return {
      runtime: status.accounts ?? [],
      poolSize: status.accounts?.length ?? 0,
      saved: records.length
        ? records.map((row, index) => ({
            index: index + 1,
            token: maskToken(row.token),
            deviceId: row.deviceId,
            source: row.source,
            pool: poolMap.get(row.token) || 'main',
            status: row.status || 'ok',
            revokedAt: row.revokedAt || null,
            revokedReason: row.revokedReason || null,
            revoked: (getTokenMeta(config.dataDir, row.token).revokedCount || 0) || 0,
          }))
        : saved.map((token, index) => ({ index: index + 1, token: maskToken(token) })),
      savedAt,
      poolCounts: counts,
      authFile,
      dbFile: configDbFile(),
      store: 'sqlite',
      engine: status.engine,
      token: status.token,
      exits: status.exits ?? [],
      pacing: status.pacing ?? null,
      usageShape: status.usageShape ?? null,
      restartRequiredForTokens: false,
    };
  }

  function parseTokenInput(input) {
    // 字符串要按「不切开 JSON 内部」的规则切分；数组视为已经分好组，逐项 normalize
    const list = Array.isArray(input) ? input : splitTokenCandidates(input);
    if (!list.length) throw new ApiError(400, '没有提供 token');
    if (list.length > MAX_TOKENS_PER_REQUEST) {
      throw new ApiError(400, `一次最多提交 ${MAX_TOKENS_PER_REQUEST} 个 token`);
    }
    return list.map((raw, index) => {
      try {
        return normalizeUserToken(String(raw));
      } catch (err) {
        throw new ApiError(400, `第 ${index + 1} 个 token 不合法：${err.message}`);
      }
    });
  }

  function saveAccounts(body) {
    const pool = POOLS.includes(String(body?.pool)) ? String(body.pool) : 'main';
    const tokens = parseTokenInput(body?.tokens);
    const mode = body?.mode === 'append' ? 'append' : 'replace';
    const store = tokenStoreSafe();
    if (!store) throw new ApiError(500, '号池数据库不可用');

    const inPool = store.list(pool).map((r) => r.token);
    const merged = mode === 'append' ? [...new Set([...inPool, ...tokens])] : tokens;
    if (mode === 'replace') {
      for (const t of inPool) if (!merged.includes(t)) store.remove(t);
    }
    for (const t of merged) store.add(t, { source: 'admin', pool });

    const applied = pool === 'main' ? reloadMainPool() : null;
    log.info(`号池[${pool}]已热更新：${merged.length} 个 token（${mode}）`, applied || {});
    return {
      ok: true,
      pool,
      mode,
      savedCount: merged.length,
      tokens: merged.map(maskToken),
      poolCounts: store.counts(),
      authFile,
      restartRequired: false,
      applied,
      message: `已写入 ${pool === 'solver' ? '解题' : '主'}号池（config.db），${pool === 'solver' ? '不需要重启' : '已热更新引擎'}。`,
    };
  }

  /** 在 main / solver 两个池之间移动一个 token */
  function moveAccount(body) {
    const store = tokenStoreSafe();
    if (!store) throw new ApiError(500, '号池数据库不可用');
    const pool = POOLS.includes(String(body?.pool)) ? String(body.pool) : null;
    if (!pool) throw new ApiError(400, `目标池不合法：${body?.pool}`);
    // 前端列表显示的是打码 token，所以**优先用序号**解析；
    // 顺序与 buildAccounts 的展示列表保持一致（loadTokenRecords）。
    let token = String(body?.token || '').trim();
    if (token && !store.get(token)) token = ''; // 传的是打码值，忽略
    if (!token) {
      const index = Number.parseInt(body?.index, 10);
      const shown = loadTokenRecords(config);
      const fallback = store.list();
      const list = shown.length ? shown : fallback;
      if (!Number.isFinite(index) || index < 1 || index > list.length) {
        throw new ApiError(400, `要移动的序号不合法：${body?.index}（当前列表 ${list.length} 个）`);
      }
      token = list[index - 1].token;
    }
    if (!store.get(token)) throw new ApiError(404, '这个 token 不在号池里');
    store.setPool(token, pool);
    // 任何移动都要重算主池：从主池移走时引擎也得把它丢掉，否则还会继续用
    const applied = reloadMainPool();
    return { ok: true, pool, token: maskToken(token), poolCounts: store.counts(), applied };
  }

  function removeAccount(body) {
    const index = Number.parseInt(body?.index, 10);
    const tokens = loadTokens(config);
    if (!Number.isFinite(index) || index < 1 || index > tokens.length) {
      throw new ApiError(400, `要删除的序号不合法：${body?.index}`);
    }
    const removed = tokens.splice(index - 1, 1);
    if (!tokens.length) {
      throw new ApiError(400, '这是最后一个 token，删掉后号池就空了。可用「替换全部」写入新 token。');
    }
    saveTokens(config, tokens);
    const applied = typeof web.reloadTokens === 'function' ? web.reloadTokens(tokens) : null;
    log.info(`已删除号池第 ${index} 个 token（热更新）`, applied || {});
    return {
      ok: true,
      removed: removed.map(maskToken),
      savedCount: tokens.length,
      restartRequired: false,
      applied,
      message: '已从数据库删除并热更新引擎，无需重启。',
    };
  }

  async function verifyTokens(rawTokens) {
    const tokens = parseTokenInput(rawTokens);
    if (verifying) throw new ApiError(409, '已有校验任务在进行，请稍后再试');
    verifying = true;
    const results = [];
    try {
      for (const token of tokens) {
        results.push({ token: maskToken(token), ...(await verifyOne(token)) });
      }
    } finally {
      verifying = false;
    }
    return { ok: results.every((r) => r.ok), results };
  }

  async function verifyOne(token) {
    let engine;
    const startedAt = Date.now();
    try {
      // 用同一个引擎实现校验：能走 checkLogin 就走，否则发一条最短的消息
      engine = createEngine({
        config: {
          ...config,
          deepseek: { ...config.deepseek, tokens: [token], token },
        },
        logger: logger.child('verify'),
      });
      if (typeof engine.checkLogin === 'function') {
        const login = await engine.checkLogin();
        return {
          ok: Boolean(login.ok),
          detail: login.ok ? '登录态有效' : login.captcha ? '遇到人机验证' : 'token 无效或已过期',
          ms: Date.now() - startedAt,
        };
      }
      const result = await engine.chat({
        prompt: '# Messages:\n## System:\n你是校验程序。\n## User:\n只回复两个字：正常',
        thinking: false,
      });
      return {
        ok: true,
        detail: `调用成功，返回：${String(result.text ?? '').slice(0, 20)}`,
        ms: Date.now() - startedAt,
      };
    } catch (err) {
      if (err?.code === 'deepseek_rate_limited') {
        return { ok: true, detail: '账号被限流，token 本身可能有效', ms: Date.now() - startedAt };
      }
      return { ok: false, detail: err.message, ms: Date.now() - startedAt };
    } finally {
      await engine?.close?.().catch(() => {});
    }
  }

  function buildConfig() {
    const dbFile = configDbFile();
    const values = {};
    for (const item of ENV_SCHEMA) {
      const current = currentEffective(item.key);
      values[item.key] = current === undefined || current === null ? '' : String(current);
    }
    return {
      // 兼容旧前端字段：envFile 现在指向 SQLite 文件
      envFile: dbFile,
      configDb: dbFile,
      dbFile,
      storage: 'sqlite',
      exists: fs.existsSync(dbFile),
      schema: ENV_SCHEMA,
      values,
      restartKeys: RESTART_KEYS,
      note: '修改会写入 data/config.db 并即时生效，无需重启；HOST / PORT / CONCURRENCY / QUEUE_LIMIT / WARMUP 需要重启后生效。',
    };
  }

  function saveConfig(body) {
    const incoming = body?.values;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new ApiError(400, 'values 必须是对象');
    }
    const updates = {};
    for (const item of ENV_SCHEMA) {
      if (!(item.key in incoming)) continue;
      const value = validateEnvValue(item, incoming[item.key]);
      // API_KEY 没改时 GET 会回显掩码占位符，别把占位符当成新 key 存进去
      if (item.key === 'API_KEY' && value === MASKED_API_KEY) continue;
      updates[item.key] = value;
    }
    const saved = Object.keys(updates);
    if (!saved.length) throw new ApiError(400, '没有需要保存的配置');

    // 1) 落盘 SQLite（重启后仍然生效）  2) 原地热更运行中的 config
    configStore().setMany(updates);
    const applied = applyConfigValues(config, updates);
    // LOG_LEVEL 是 logger 构造时捕获的阈值：热更后让所有 child logger 一起生效
    logger.setLevel?.(config.logLevel);

    const restartRequired = saved.some((key) => RESTART_KEYS.includes(key));
    const dbFile = configDbFile();
    log.info('配置已保存到 SQLite', { keys: saved, applied, restartRequired });
    return {
      ok: true,
      storage: 'sqlite',
      dbFile,
      envFile: dbFile,
      saved,
      applied: true,
      restartRequired,
      message: restartRequired
        ? '已保存；HOST / PORT / CONCURRENCY / QUEUE_LIMIT / WARMUP 需要重启后生效，其余已即时生效。'
        : '已保存并即时生效',
    };
  }

  function validateEnvValue(item, raw) {
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (item.type === 'boolean') {
      if (!['true', 'false', ''].includes(value)) {
        throw new ApiError(400, `${item.key} 只能是 true / false`);
      }
      return value === '' ? 'false' : value;
    }
    if (item.type === 'number') {
      if (value === '') return '';
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ApiError(400, `${item.key} 必须是数字`);
      if (item.min !== undefined && n < item.min) throw new ApiError(400, `${item.key} 不能小于 ${item.min}`);
      if (item.max !== undefined && n > item.max) throw new ApiError(400, `${item.key} 不能大于 ${item.max}`);
      return String(Math.trunc(n));
    }
    if (item.type === 'select') {
      if (!item.options.includes(value)) {
        throw new ApiError(400, `${item.key} 只能是 ${item.options.join(' / ')}`);
      }
      return value;
    }
    if (/[\r\n]/.test(value)) throw new ApiError(400, `${item.key} 不能包含换行`);
    return value;
  }

  /** 当前进程里生效的值（SQLite / 环境变量 / 默认值合并后的结果） */
  function currentEffective(key) {
    const mapping = {

      DEEPSEEK_SEARCH: String(config.deepseek.search),
      DEFAULT_MODEL: config.deepseek.defaultModel,
      LOG_LEVEL: config.logLevel,
      CONCURRENCY: String(config.runtime.concurrency),
      QUEUE_LIMIT: String(config.runtime.queueLimit),
      REQUEST_TIMEOUT_MS: String(config.runtime.requestTimeoutMs),
      FIRST_TOKEN_TIMEOUT_MS: String(config.runtime.firstTokenTimeoutMs),
      MAX_PROMPT_CHARS: String(config.runtime.maxPromptChars),
      MAX_ATTACHMENT_CHARS: String(config.runtime.maxAttachmentChars),
      OVERFLOW_TO_ATTACHMENT: String(config.runtime.overflowToAttachment),
      TOOL_DECL_MODE: config.runtime.toolDeclMode,
      WARMUP: String(config.runtime.warmup),
      SAVE_ARTIFACTS: String(config.runtime.saveArtifacts),
      ACCOUNT_COOLDOWN_MS: String(config.runtime.accountCooldownMs),
      CORS_ORIGIN: config.server.cors,
      HOST: config.server.host,
      PORT: String(config.server.port),
      API_KEY: config.server.apiKey ? MASKED_API_KEY : '',
    };
    return mapping[key];
  }

  function readLogTail(lines) {
    let text = '';
    try {
      const stat = fs.statSync(serverLog);
      const length = Math.min(stat.size, 512 * 1024);
      const fd = fs.openSync(serverLog, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { file: serverLog, exists: false, lines: [], size: 0 };
    }
    const all = text.split(/\r?\n/);
    const tail = all.slice(Math.max(0, all.length - lines - 1), -1);
    return { file: serverLog, exists: true, lines: tail, size: text.length };
  }

  async function restartServer() {
    if (!fs.existsSync(ctlScript)) {
      throw new ApiError(500, `找不到重启脚本：${ctlScript}`);
    }
    const child = spawn(process.execPath, [ctlScript, 'restart'], {
      cwd: rootDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    log.info('收到后台重启请求，已交给 server-ctl restart', { pid: child.pid });
    return {
      ok: true,
      message: '正在重启服务，页面会自动重连…',
      pid: child.pid,
    };
  }

  /* ------------------------------------------------------------------ *
   * 静态页面
   * ------------------------------------------------------------------ */

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice('/admin/'.length)) || 'index.html';

    // 单文件二进制：资源在内存里，直接发（不碰磁盘）
    if (embeddedWeb.count) {
      const hit = embeddedWeb.getWebAsset(relative) || embeddedWeb.getWebAsset('index.html');
      if (hit) {
        res.writeHead(200, {
          'Content-Type': hit.type,
          'Content-Length': hit.buffer.length,
          'Cache-Control': relative.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(hit.buffer);
      }
    }

    const resolved = path.resolve(distDir, relative);
    const inside = resolved === distDir || resolved.startsWith(distDir + path.sep);
    const fallback = path.join(distDir, 'index.html');

    let stat = null;
    try {
      stat = inside ? fs.statSync(resolved) : null;
    } catch {
      stat = null;
    }
    let file = stat?.isFile() ? resolved : fallback;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendHtml(res, 503, buildMissingPage());
    }
    if (!stat.isFile()) return sendHtml(res, 503, buildMissingPage());
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    // 流式发送：原来每次请求都把整个文件（主 JS 约 588KB）读进内存，
    // 并发访问后台时内存峰值随并发线性增长；流式只占一个小缓冲区。
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => {
      if (!res.headersSent) sendHtml(res, 503, buildMissingPage());
      else res.end();
    }).pipe(res);
  }
}

/* -------------------------------------------------------------------- *
 * 工具函数
 * -------------------------------------------------------------------- */



function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}



function buildMissingPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>fuckds 控制台尚未构建</title>
<style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1f2328}
pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:14px;overflow:auto;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style>
<h1>控制台还没构建</h1>
<p>后台前端在 <code>web/</code>（React + Vite + mdui），需要先构建一次：</p>
<pre>cd ${escapeHtml(process.cwd())}
npm --prefix web install
npm --prefix web run build</pre>
<p>构建产物输出到 <code>web/dist</code>，本页面会自动出现。开发时可另开一个终端跑 <code>npm --prefix web run dev</code>。</p>
</html>`;
}

