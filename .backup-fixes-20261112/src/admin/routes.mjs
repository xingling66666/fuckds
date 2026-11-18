import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ApiError } from '../errors.mjs';
import { escapeHtml, readJsonBody, requireApiKey, sendHtml, sendJson } from '../http.mjs';
import { loadTokens, maskToken, normalizeUserToken, saveTokens } from '../auth.mjs';
import { applyConfigValues } from '../config.mjs';
import { openConfigStore } from '../config-store.mjs';
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
  { key: 'ENGINE', label: '引擎', type: 'select', options: ['direct', 'auto', 'browser'], help: 'direct 直连最快；browser 用 Playwright 驱动真实网页（修改后需重启）' },
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
const RESTART_KEYS = ['ENGINE', 'HOST', 'PORT', 'CONCURRENCY', 'QUEUE_LIMIT', 'WARMUP'];

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

    if (route === 'POST /admin/api/accounts/remove') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, removeAccount(body));
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
        engine: config.engine,
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
        powBin: config.direct.powBin,
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

  function buildAccounts() {
    const status = web.status();
    const saved = loadTokens(config);
    let savedAt = null;
    try {
      savedAt = JSON.parse(fs.readFileSync(authFile, 'utf8')).savedAt ?? null;
    } catch {
      savedAt = null;
    }
    return {
      runtime: status.accounts ?? [],
      poolSize: status.accounts?.length ?? 0,
      saved: saved.map((token, index) => ({ index: index + 1, token: maskToken(token) })),
      savedAt,
      authFile,
      engine: status.engine,
      token: status.token,
    };
  }

  function parseTokenInput(input) {
    const list = Array.isArray(input)
      ? input
      : String(input ?? '')
          .split(/[\s,;]+/)
          .filter(Boolean);
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
    const tokens = parseTokenInput(body?.tokens);
    const mode = body?.mode === 'append' ? 'append' : 'replace';
    const existing = mode === 'append' ? loadTokens(config) : [];
    const merged = [...new Set([...existing, ...tokens])];
    saveTokens(config, merged);
    log.info(`号池已更新：${merged.length} 个 token（${mode}）`);
    return {
      ok: true,
      mode,
      savedCount: merged.length,
      tokens: merged.map(maskToken),
      authFile,
      restartRequired: true,
      message: '已写入 data/auth.json。运行中的进程仍在使用旧号池，重启服务后生效。',
    };
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
    log.info(`已删除号池第 ${index} 个 token`);
    return {
      ok: true,
      removed: removed.map(maskToken),
      savedCount: tokens.length,
      restartRequired: true,
      message: '已从 data/auth.json 删除，重启服务后生效。',
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
      note: '修改会写入 data/config.db 并即时生效，无需重启；HOST / PORT / ENGINE / CONCURRENCY / QUEUE_LIMIT / WARMUP 需要重启后生效。',
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
        ? '已保存；HOST / PORT / ENGINE / CONCURRENCY / QUEUE_LIMIT / WARMUP 需要重启后生效，其余已即时生效。'
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
      ENGINE: config.engine,
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

