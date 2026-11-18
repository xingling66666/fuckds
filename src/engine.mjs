import path from 'node:path';

import { DeepSeekWeb } from './browser/driver.mjs';
import { resolvePowBin } from './direct/pow-binary.mjs';
import { DirectEngine } from './direct/client.mjs';
import { openTokenStore } from './token-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 引擎装配：**登录走浏览器，转发走逆向接口**。
 *
 * 为什么这么分：
 *
 * - 登录必须留在真浏览器里。DeepSeek 的登录链路有数美点选、MFA、请求体 RSA/AES 加密、
 *   设备号生成，任何一步用脚本硬拼都更容易被判定成机器（参见 login.mjs 的注释）。
 *   浏览器在这里只干一件事：把真人账号登上去，拿到 `localStorage.userToken`。
 *
 * - 转发不再经过浏览器。对话本身是纯 HTTP：`chat_session/create` + `create_pow_challenge`
 *   + `chat/completion`（SSE），请求头、PoW、增量协议都在
 *   `/root/dsh/DeepSeek网页接口逆向日记.md` 里对齐过，`src/direct/` 有完整实现。
 *   走直连之后：不用起页面、不用等 DOM 渲染、不用跟虚拟列表抢文本、延迟低一个数量级，
 *   也不会因为 DOM 序列化把工具调用的控制字符吃掉。
 *
 * 模式（`DS_ENGINE` 环境变量，默认 hybrid）：
 *   hybrid  转发 = direct，登录/体检辅助 = browser（默认）
 *   direct  连浏览器都不启动（token 由外部提供）
 *   （旧 browser 转发模式已移除；DS_ENGINE=browser 会自动降级成 hybrid）
 *   direct  全部走直连（连登录辅助都不用；token 需要外部喂进来）
 *
 * 注意：hybrid 下浏览器**不会**因为一次对话就被启动。只有调用 `newPage()`（自动登录）、
 * `loginCheck()`（浏览器视角的登录态检查）时才会拉起 Chromium。
 */
export class HybridEngine {
  constructor({ config, logger, pool = 'main' }) {
    /** 这个引擎实例只用哪一类号：main（正常转发）/ solver（只答验证码） */
    this.pool = pool;
    this.config = config;
    this.log = logger;
    this.mode = resolveMode(config);

    // 直连引擎需要一个 PoW 求解器二进制：优先 config.direct.powBin，缺省用仓库内的 bin/ds-pow
    this.directConfig = {
      ...config,
      direct: {
        // 注意顺序：必须最后覆盖 powBin，否则 config.direct 里的旧值（编译后是
        // /$bunfs/bin/ds-pow 这种虚拟路径）会把「内联解包后的真实路径」盖掉
        ...(config.direct || {}),
        powBin:
          resolvePowBin(config.direct?.powBin || path.join(ROOT, 'bin', 'ds-pow')) ||
          path.join(ROOT, 'bin', 'ds-pow'),
      },
      deepseek: {
        ...config.deepseek,
        // 直连请求头里的 x-client-* 与浏览器指纹共用一份配置，别各写一套
        locale: config.deepseek?.locale || 'zh_CN',
      },
    };

    // 转发永远走直连。browser 只作为「登录 / 体检」的辅助，不再承担任何转发工作。
    this.direct = new DirectEngine({
      config: this.directConfig,
      logger: typeof logger?.child === 'function' ? logger.child('direct') : logger,
    });
    this.browser = this.mode === 'direct' ? null : new DeepSeekWeb({
      config,
      logger: typeof logger?.child === 'function' ? logger.child('login') : logger,
    });

    /** 最近一次登录态检查的结果（给后台展示用，不代表「浏览器已启动」） */
    this.loginState = { at: 0, ok: false, msg: '', code: null, via: null };

    /**
     * 启动时把 auth.json 的 token 与号池表（SQLite `tokens`）合并。
     *
     * auth.json 只是「引导用」的单 token，后台加号落在号池表里。不合并的话，
     * 进程一重启直连引擎就只认 auth.json 那一个号 —— 后台里明明有一排号，
     * 实际转发只用其中一个，表现成「号池有号但没生效」。合并后顺序上 auth.json 的在前。
     */
    if (this.direct) {
      // 主池只装 main 池的号（先把构造函数里 loadTokens 全量装的号清掉）
      if (this.pool === 'main') {
        try {
          const store = openTokenStore({ dataDir: config.dataDir });
          const mainOnly = store
            .list('main')
            .filter((r) => (r.status || 'ok') !== 'revoked')
            .map((r) => r.token)
            .filter(Boolean);
          if (mainOnly.length) this.direct.reloadTokens(mainOnly);
        } catch {}
      }
      this.#mergeStoredTokens();
    }
  }

  /** 把「本实例对应号池」的 token 装进直连号池 */
  #mergeStoredTokens() {
    try {
      const store = openTokenStore({ dataDir: this.config.dataDir });
      // 只用未吊销的号（吊销标记是持久化的，重启后依然有效）
      const stored = store
        .list(this.pool)
        .filter((row) => (row.status || 'ok') !== 'revoked')
        .map((row) => row.token)
        .filter(Boolean);

      // solver 池是独立专用的：**不与主池/auth.json 混用**，池里没有就是没有
      if (this.pool !== 'main') {
        this.direct?.reloadTokens(stored, { allowEmpty: true });
        this.log?.info?.(`解题号池已加载 ${stored.length} 个 token（仅用于过人机验证）`);
        return;
      }

      if (!stored.length) return;
      const current = this.direct.tokens || [];
      const merged = [...new Set([...current, ...stored])];
      if (merged.length > current.length) {
        this.direct.reloadTokens(merged);
        this.log?.info?.(`号池已合并：auth.json ${current.length} 个 + 号池表 ${stored.length} 个 → ${merged.length} 个`);
      }
    } catch (err) {
      this.log?.debug?.(`合并号池表失败（忽略）: ${err.message}`);
    }
  }

  get engineName() {
    return this.mode === 'direct' ? 'direct' : 'hybrid';
  }

  /* ------------------------------------------------------------------ *
   * 转发：直连（不经浏览器）
   * ------------------------------------------------------------------ */

  async chat(args) {
    return this.direct.chat(args);
  }

  async uploadImages(images) {
    return this.direct.uploadImages(images);
  }

  async uploadAttachments(files) {
    return this.direct.uploadAttachments(files);
  }

  /* ------------------------------------------------------------------ *
   * 号池 / 登录态
   * ------------------------------------------------------------------ */

  /**
   * 号池热更新：自动登录刚拿到新 token、后台加号/删号都走这里。
   * 有直连引擎时直接换池（不需要重建浏览器）；纯浏览器模式沿用旧实现。
   */
  reloadTokens(tokens, options = {}) {
    if (this.direct) return this.direct.reloadTokens(tokens, options);
    if (typeof this.browser?.reloadTokens === 'function') return this.browser.reloadTokens(tokens);
    return null;
  }

  /**
   * 往号池里**追加** token（自动登录拿到新号时用）。
   *
   * 与 `reloadTokens` 的区别很关键：自动登录只产生一个新 token，
   * 直接 reload 会把它当成"整池替换"，把账号池里其它还活着的号全丢掉。
   * 这里做并集，新 token 放最前面（优先被选中）。
   */
  addTokens(tokens) {
    const list = (Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean);
    if (!list.length) return null;
    if (this.direct) {
      const existing = this.direct.tokens || [];
      const merged = [...new Set([...list, ...existing])];
      return this.direct.reloadTokens(merged);
    }
    return this.reloadTokens(list);
  }

  /**
   * 登录态检查：默认用直连的只读探针（`GET /api/v0/users/current`），
   * 便宜、无副作用、不用起浏览器。直连模式下这也是唯一手段。
   */
  async checkLogin(options = {}) {
    let result;
    if (this.direct) {
      result = await this.direct.checkLogin(options);
    } else {
      result = await this.browser.checkLogin();
      result = { ok: Boolean(result?.ok), code: result?.ok ? 0 : 40003, msg: result?.ok ? '' : '浏览器里没有登录态', url: result?.url };
    }
    this.loginState = {
      at: Date.now(),
      ok: Boolean(result?.ok),
      msg: result?.msg || '',
      code: result?.code ?? null,
      via: 'api',
    };
    return result;
  }

  /** 后台「体检」用：alive + code + msg */
  async probe() {
    const r = await this.checkLogin();
    return { alive: Boolean(r?.ok), code: r?.code ?? null, msg: r?.msg || '' };
  }

  /** 浏览器视角的登录态（自动登录脚本、`npm run auth` 用） */
  async loginCheck() {
    if (!this.browser) {
      const r = await this.checkLogin();
      return { ok: Boolean(r?.ok), url: r?.url, captcha: false };
    }
    return this.browser.checkLogin();
  }

  /** 拿一个浏览器页面（**只在自动登录 / 人工介入时用**，不参与日常转发） */
  async newPage() {
    if (!this.browser) throw new Error('direct 模式下没有浏览器：自动登录请用 DS_ENGINE=hybrid');
    return this.browser.newPage();
  }

  /* ------------------------------------------------------------------ *
   * 生命周期 / 状态
   * ------------------------------------------------------------------ */

  /**
   * 预热：直连侧先把 PoW / 会话解好，第一次请求就不用等；
   * **不**预热浏览器（转发不走它，启动 Chromium 纯属浪费）。
   */
  async warmUp() {
    if (this.direct) {
      try {
        await this.direct.warmUp();
      } catch (err) {
        this.log?.warn?.(`直连预热失败（忽略）: ${err.message}`);
      }
      return;
    }
    await this.browser?.warmUp?.();
  }

  status() {
    const base = this.direct.status();
    const browserStatus = this.browser?.status?.() ?? null;
    return {
      ...base,
      engine: this.engineName,
      mode: this.mode,
      // browser 字段表示「转发是否经过浏览器」，hybrid 下恒为 false
      browser: false,
      /** 浏览器进程是否真的起来了（只有自动登录时才会） */
      browserActive: Boolean(browserStatus?.browser),
      pages: browserStatus?.pages ?? 0,
      login: { ...this.loginState },
      accounts: base.accounts ?? [],
    };
  }

  async close() {
    await Promise.all([
      this.direct?.close?.() ?? null,
      this.browser?.close?.() ?? null,
    ]);
  }
}

/**
 * 引擎模式。
 *
 * browser 转发模式**已彻底移除**（DOM 驱动又慢又脆，且会把工具调用控制字符吃掉）。
 * 现在只有两种：
 *   hybrid —— 转发走直连接口，浏览器只在「登录 / 体检」时按需启动（默认）
 *   direct —— 连浏览器都不启动，token 由外部提供
 * 历史配置里如果还写着 DS_ENGINE=browser，会自动降级成 hybrid。
 */
function resolveMode(config) {
  const raw = String(process.env.DS_ENGINE || config?.engine?.mode || 'hybrid').toLowerCase();
  if (raw === 'direct') return 'direct';
  return 'hybrid';
}

export function createEngine({ config, logger, pool = 'main' }) {
  return new HybridEngine({ config, logger, pool });
}
