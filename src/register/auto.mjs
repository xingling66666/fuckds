/**
 * 自动注册（无需 VNC、无需人工）
 *
 * 复用 VncRegisterSession 的浏览器链路：过 WAF → 填表 → 自动过 hCaptcha（无障碍题）
 * → 发码 → **IMAP 自动收码** → 填码 → 注册 → userToken 入号池。
 *
 * 关键点（都是踩坑换来的）：
 *  - 必须用「移动端指纹」（Android + 高通 GPU + dpr3 + 5 点触控），
 *    桌面 Linux + SwiftShader 会直接被判 RISK_DEVICE_DETECTED；
 *  - 每次注册都要换新邮箱别名（base+ds<时间戳>@domain），复用地址会 ACCOUNT_ALREADY_EXISTS；
 *  - 发码有 60s 频率限制，所以两次注册之间至少隔 1 分钟；
 *  - 一个 IP 连续注册会累积风险，默认间隔 10 分钟、每日上限可配。
 */

import { VncRegisterSession } from './vnc-session.mjs';
import { waitForCode, collectCodes } from '../mail/mailbox.mjs';
import { openTokenStore } from '../token-store.mjs';
import { normalizeProxy, checkExitIp } from './proxy.mjs';
import { resolveOAuthClient } from '../mail/oauth.mjs';

const KEY = {
  enabled: 'REG_ENABLED',
  emailBase: 'REG_EMAIL_BASE',
  emailBases: 'REG_EMAIL_BASES',
  emailPool: 'REG_EMAIL_POOL',
  useEmailPools: 'REG_USE_EMAIL_POOLS',
  emailDomain: 'REG_EMAIL_DOMAIN',
  password: 'REG_PASSWORD',
  imapHost: 'REG_IMAP_HOST',
  imapPort: 'REG_IMAP_PORT',
  imapUser: 'REG_IMAP_USER',
  imapPass: 'REG_IMAP_PASS',
  mailbox: 'REG_MAILBOX',
  imapAuthMode: 'REG_IMAP_AUTH_MODE',
  oauthPreset: 'REG_IMAP_OAUTH_PRESET',
  oauthClientId: 'REG_IMAP_OAUTH_CLIENT_ID',
  oauthTenant: 'REG_IMAP_OAUTH_TENANT',
  oauthRefreshToken: 'REG_IMAP_OAUTH_REFRESH_TOKEN',
  oauthScope: 'REG_IMAP_OAUTH_SCOPE',
  intervalMin: 'REG_INTERVAL_MIN',
  windowStart: 'REG_WINDOW_START',
  windowEnd: 'REG_WINDOW_END',
  dailyMax: 'REG_DAILY_MAX',
  proxy: 'REG_PROXY',
  fp: 'REG_FP',
  results: 'REG_RESULTS',
  lastRunAt: 'REG_LAST_RUN_AT',
  dayCount: 'REG_DAY_COUNT',
  dayKey: 'REG_DAY_KEY',
  lastError: 'REG_LAST_ERROR',
};

const DEFAULTS = {
  enabled: false,
  emailBase: '',
  emailBases: '',
  emailPool: '',
  useEmailPools: '0',
  emailDomain: 'outlook.com',
  password: '',
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  imapPass: '',
  mailbox: 'INBOX',
  imapAuthMode: 'password',
  oauthPreset: 'thunderbird',
  oauthClientId: '',
  oauthTenant: 'consumers',
  oauthRefreshToken: '',
  oauthScope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access',
  intervalMin: 10,
  windowStart: '00:00',
  windowEnd: '23:59',
  dailyMax: 5,
  proxy: '',
  fp: 'random',
};

const RESULT_CAP = 30;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function minutesOf(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return fallback;
  return Number(m[1]) * 60 + Number(m[2]);
}

export class AutoRegister {
  constructor({ config, logger, engine = null, onTokenAdded = null }) {
    this.config = config;
    this.logger = logger;
    /** hCaptcha 无障碍题的答题引擎（不传就只能人工过） */
    this.engine = engine;
    /** 注册成功后的回调：上层用它把新号热更新进主引擎（否则要重启才生效） */
    this.onTokenAdded = onTokenAdded;
    this.log = typeof logger?.child === 'function' ? logger.child('register') : console;
    this.running = false;
    this.state = 'idle';
    this.step = '';
    this.error = '';
    this.currentEmail = '';
    this.startedAt = 0;
    this.logs = [];
    this.timer = null;
    this.session = null;
    /** 手动填码模式：这里挂着等待用户从后台提交验证码的 Promise */
    this.pendingCode = null;
    this.mode = 'auto';
    /** 本轮已用过的验证码（防止重复拿到旧码） */
    this.usedCodes = new Set();
  }

  /** 手动模式下由后台把验证码递进来 */
  submitCode(code) {
    const value = String(code || '').trim();
    if (!/^\d{4,8}$/.test(value)) return { ok: false, error: '验证码格式不对（应为 4~8 位数字）' };
    if (!this.pendingCode) return { ok: false, error: '当前没有在等验证码' };
    this.pendingCode.resolve(value);
    return { ok: true, code: value };
  }

  /** 挂起等待手动验证码（最长 10 分钟） */
  #waitManualCode(timeoutMs = 10 * 60_000) {
    this.step = '等待手动输入验证码';
    this.#push('⏳ 验证码已发出，请把收到的 6 位码填到后台');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCode = null;
        reject(new Error('等待手动验证码超时（10 分钟）'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pendingCode = {
        resolve: (code) => {
          clearTimeout(timer);
          this.pendingCode = null;
          this.#push(`✅ 收到手动验证码 ${code}`);
          resolve(code);
        },
      };
    });
  }

  /** 配置库（settings 表：REG_*） */
  #store() {
    return this.config.store;
  }

  /** 号池库（tokens 表：main / solver）—— 和配置库是两个不同的库，别混用 */
  #tokenStore() {
    try {
      return openTokenStore({ dataDir: this.config.dataDir });
    } catch {
      return null;
    }
  }

  #push(line) {
    const item = { at: Date.now(), line: String(line) };
    this.logs.push(item);
    if (this.logs.length > 200) this.logs.splice(0, this.logs.length - 200);
    if (typeof this.log?.info === 'function') this.log.info(String(line));
    else console.log(line);
  }

  /* ---------------- 设置 ---------------- */

  settings() {
    const store = this.#store();
    const get = (k, d) => {
      const v = store?.get?.(k);
      return v === undefined || v === null || v === '' ? d : v;
    };
    return {
      enabled: String(get(KEY.enabled, DEFAULTS.enabled ? '1' : '0')) === '1',
      emailBase: String(get(KEY.emailBase, DEFAULTS.emailBase)),
      emailBases: String(get(KEY.emailBases, DEFAULTS.emailBases)),
      emailPool: String(get(KEY.emailPool, DEFAULTS.emailPool)),
      useEmailPools: String(get(KEY.useEmailPools, DEFAULTS.useEmailPools)) === '1',
      emailDomain: String(get(KEY.emailDomain, DEFAULTS.emailDomain)),
      password: String(get(KEY.password, DEFAULTS.password)),
      imapHost: String(get(KEY.imapHost, DEFAULTS.imapHost)),
      imapPort: Number(get(KEY.imapPort, DEFAULTS.imapPort)) || 993,
      imapUser: String(get(KEY.imapUser, DEFAULTS.imapUser)),
      imapPass: String(get(KEY.imapPass, DEFAULTS.imapPass)),
      mailbox: String(get(KEY.mailbox, DEFAULTS.mailbox)),
      imapAuthMode: String(get(KEY.imapAuthMode, DEFAULTS.imapAuthMode)) === 'oauth' ? 'oauth' : 'password',
      oauthPreset: String(get(KEY.oauthPreset, DEFAULTS.oauthPreset)),
      oauthClientId: String(get(KEY.oauthClientId, DEFAULTS.oauthClientId)),
      oauthTenant: String(get(KEY.oauthTenant, DEFAULTS.oauthTenant)),
      oauthRefreshToken: String(get(KEY.oauthRefreshToken, DEFAULTS.oauthRefreshToken)),
      oauthScope: String(get(KEY.oauthScope, DEFAULTS.oauthScope)),
      intervalMin: Number(get(KEY.intervalMin, DEFAULTS.intervalMin)) || 10,
      windowStart: String(get(KEY.windowStart, DEFAULTS.windowStart)),
      windowEnd: String(get(KEY.windowEnd, DEFAULTS.windowEnd)),
      dailyMax: Number(get(KEY.dailyMax, DEFAULTS.dailyMax)) || 5,
      proxy: normalizeProxy(String(get(KEY.proxy, this.config.deepseek?.proxies?.[0] || '')) || ''),
      fp: String(get(KEY.fp, 'random')),
    };
  }

  saveSettings(patch = {}) {
    const store = this.#store();
    const map = {
      enabled: [KEY.enabled, (v) => (v ? '1' : '0')],
      emailBase: [KEY.emailBase, (v) => String(v || '').trim()],
      emailBases: [KEY.emailBases, (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).join(',')],
      useEmailPools: [KEY.useEmailPools, (v) => (v ? '1' : '0')],
      emailPool: [KEY.emailPool, (v) => String(v || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => x.includes('@')).join(',')],
      emailDomain: [KEY.emailDomain, (v) => String(v || '').trim()],
      password: [KEY.password, (v) => String(v ?? '')],
      imapHost: [KEY.imapHost, (v) => String(v || '').trim()],
      imapPort: [KEY.imapPort, (v) => String(Number(v) || 993)],
      imapUser: [KEY.imapUser, (v) => String(v || '').trim()],
      imapPass: [KEY.imapPass, (v) => String(v ?? '')],
      mailbox: [KEY.mailbox, (v) => String(v || 'INBOX').trim()],
      imapAuthMode: [KEY.imapAuthMode, (v) => (String(v) === 'oauth' ? 'oauth' : 'password')],
      oauthPreset: [KEY.oauthPreset, (v) => (['thunderbird', 'office', 'custom'].includes(String(v)) ? String(v) : 'thunderbird')],
      oauthClientId: [KEY.oauthClientId, (v) => String(v || '').trim()],
      oauthTenant: [KEY.oauthTenant, (v) => String(v || 'consumers').trim()],
      oauthRefreshToken: [KEY.oauthRefreshToken, (v) => String(v ?? '').trim()],
      oauthScope: [KEY.oauthScope, (v) => String(v || DEFAULTS.oauthScope).trim()],
      intervalMin: [KEY.intervalMin, (v) => String(Math.max(1, Number(v) || 10))],
      windowStart: [KEY.windowStart, (v) => String(v || '00:00')],
      windowEnd: [KEY.windowEnd, (v) => String(v || '23:59')],
      dailyMax: [KEY.dailyMax, (v) => String(Math.max(1, Number(v) || 5))],
      proxy: [KEY.proxy, (v) => normalizeProxy(v)],
      // 指纹只能随机：固定指纹会被平台关联，这里忽略任何传入值
      fp: [KEY.fp, () => 'random'],
    };
    const saved = {};
    for (const [field, [key, norm]] of Object.entries(map)) {
      if (patch[field] === undefined) continue;
      const value = norm(patch[field]);
      store?.set?.(key, value);
      saved[field] = field.toLowerCase().includes('pass') ? '***' : value;
    }
    return { saved, settings: this.maskedSettings() };
  }

  /** 给界面用：密码类打码，但保留「已配置」信息 */
  maskedSettings() {
    const s = this.settings();
    return {
      ...s,
      password: s.password ? '***' : '',
      imapPass: s.imapPass ? '***' : '',
      oauthRefreshToken: s.oauthRefreshToken ? '***' : '',
      imapConfigured:
        s.imapAuthMode === 'oauth'
          ? Boolean(s.imapUser && (s.oauthClientId || s.oauthPreset !== 'custom') && s.oauthRefreshToken)
          : Boolean(s.imapUser && s.imapPass),
    };
  }

  /* ---------------- 执行 ---------------- */

  /**
   * 生成这次注册要用的邮箱。
   *
   * 为什么准备多个策略：DeepSeek 会按域名/别名形态判 `EMAIL_DOMAIN_NOT_SUPPORTED`。
   *  - plus ：base+ds<ts>@domain          —— 常规别名（有些服务会拒 `+`）
   *  - dot  ：base.ds<ts>@domain          —— Outlook 忽略点号，字符串不同但投同一信箱
   *  - dot0 ：b.as.e<ts>@domain           —— 点号打在中间，换一种形态再试
   * 失败时自动换下一个（最多 3 次），不用人管。
   */
  /**
   * 选一个还没被烧掉的邮箱前缀。
   *
   * 实测：一个真实邮箱大约能注册 4~6 个号，之后所有别名统一回
   * EMAIL_DOMAIN_NOT_SUPPORTED（biz_code=9）——平台把它当"域名不支持"。
   * 所以维护一个前缀池，用尽自动换下一个。
   */
  #pickBase() {
    const s = this.settings();
    const store = this.#tokenStore();
    const pool = String(s.emailBases || '')
      .split(/[,;\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (s.emailBase && !pool.includes(s.emailBase)) pool.unshift(s.emailBase);
    if (!pool.length) return '';

    const now = Date.now();
    for (const base of pool) {
      const burntAt = Number(store?.get?.(`BASE_BURN:${base}`) || 0);
      // 烧掉的 12 小时内跳过
      if (burntAt && now - burntAt < 12 * 3600e3) continue;
      return base;
    }
    // 全部烧掉：返回最早烧的那个，让平台再判一次（也许 IP 换了就过了）
    let best = pool[0];
    let bestAt = Infinity;
    for (const base of pool) {
      const t = Number(store?.get?.(`BASE_BURN:${base}`) || 0) || 0;
      if (t < bestAt) { bestAt = t; best = base; }
    }
    return best;
  }

  /** 把某个前缀标记为"用尽" */
  #burnBase(base, reason = '') {
    const store = this.#tokenStore();
    try {
      store?.set?.(`BASE_BURN:${base}`, String(Date.now()));
      store?.set?.(`BASE_BURN_REASON:${base}`, String(reason).slice(0, 120));
    } catch {}
    this.#push(`⚠️ 邮箱前缀 ${base} 已用尽（${reason}），12 小时内不再使用`);
  }

  /**
   * 地址池：每个条目是一个**完整真实地址**（如 dsm001@outlook.com）。
   *
   * 为什么要这个：DeepSeek 会把 `+tag` / 点号归一化到同一个 base，
   * 所以同一 base 的别名额度是共享的（实测 4~6 个就锁）。
   * Outlook 的「添加别名」生成的是完全不同的真实地址 → 独立额度。
   */
  #pickPooledAddress() {
    const s = this.settings();
    const pool = String(s.emailPool || '')
      .split(/[,;\s]+/)
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.includes('@'));
    if (!pool.length) return '';
    const store = this.#tokenStore();
    const now = Date.now();
    for (const addr of pool) {
      const burntAt = Number(store?.get?.(`ADDR_BURN:${addr}`) || 0);
      if (burntAt && now - burntAt < 12 * 3600e3) continue;
      return addr;
    }
    return '';
  }

  /** 给后台用：预览「下一次注册会用哪个地址」，不用真的跑一轮 */
  previewEmail() {
    try {
      const s = this.settings();
      const list = this.#aliasCandidates();
      return { ok: true, email: list[0], candidates: list, useEmailPools: s.useEmailPools, emailBase: s.emailBase, emailDomain: s.emailDomain };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  #aliasCandidates() {
    const s = this.settings();
    // 默认严格用你填的「邮箱前缀 + 域名」。
    // 只有显式打开 useEmailPools 才去用地址池/前缀池 —— 之前池子无条件优先，
    // 把我测试时塞进池里的地址顶替了用户配置，属于设计错误。
    if (!s.useEmailPools) {
      const rawBase = String(s.emailBase || '').trim();
      const domain = s.emailDomain || 'outlook.com';
      if (!rawBase) throw new Error('请先在后台填写邮箱前缀（如 deepseek666661）');
      const base = rawBase.split('@')[0];
      // gmail 现在连 `+` 都不让用了，直接用裸地址（已注册过就换前缀）
      if (domain === 'gmail.com' || domain === 'googlemail.com') return [`${base}@${domain}`];
      const tag = Math.random().toString(36).slice(2, 8);
      return [`${base}+${tag}@${domain}`];
    }
    // 地址池优先：池里有可用地址就直接用（真实地址，不加标签）
    const pooled = this.#pickPooledAddress();
    if (pooled) {
      this.#push(`使用地址池中的真实地址：${pooled}`);
      return [pooled];
    }
    const raw = String(this.#pickBase() || s.emailBase || '').trim();
    const domain = s.emailDomain || 'outlook.com';
    if (!raw) throw new Error('请先在后台填写邮箱前缀（如 xingling9464）');
    const base = raw.split('@')[0];
    // 实测结论（2026-11-17）：
    //   gmail.com 的 +tag / 点号别名 / googlemail.com 全被判 EMAIL_DOMAIN_NOT_SUPPORTED，
    //   只有裸地址放行（而裸地址已注册）→ 说明该前缀的别名额度被锁死。
    //   outlook 的 +tag 仍能过域名检查（能正常发码）。
    // 所以按域名决定策略，别再无脑拼别名。
    const d = String(domain).toLowerCase();
    if (d === 'gmail.com' || d === 'googlemail.com') {
      throw new Error(
        `gmail 的别名已被平台拒绝（${base}+xxx@${domain} → biz_code=9 域名不支持）。` +
          '请换一个邮箱前缀/账号，或改用 outlook/hotmail 域名。',
      );
    }
    const tag = Math.random().toString(36).slice(2, 8);
    return [`${base}+${tag}@${domain}`];
  }

  #nextEmail() {
    return this.#aliasCandidates()[0];
  }

  /**
   * 给一个地址生成等价变体（投递到同一信箱）：
   *   base+tag@d  →  base.tag@d  →  ba.se.tag@d
   * gmail / outlook 都忽略点号，所以这是安全的"换一个地址字符串"。
   */
  #variantsOf(addr) {
    const [local, domain] = String(addr || '').split('@');
    if (!local || !domain) return [];
    const noTag = local.split('+')[0];
    const out = [addr.toLowerCase()];
    for (const cand of [
      `${noTag}.${local.split('+')[1] || 'ds'}@${domain}`,
      `${noTag.slice(0, 4)}.${noTag.slice(4)}@${domain}`,
      `${noTag.toLowerCase()}@${domain}`,
    ]) {
      const v = String(cand).toLowerCase();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  #mailCfg() {
    const s = this.settings();
    return {
      user: s.imapUser,
      pass: s.imapPass,
      imap: { host: s.imapHost || 'imap.outlook.com', port: s.imapPort || 993, secure: true, mailbox: s.mailbox || 'INBOX' },
      smtp: { host: '', port: 0, secure: true },
      from: s.imapUser,
      codeTimeoutMs: 180_000,
      codeRegex: '(?<!\\d)(\\d{6})(?!\\d)',
      oauth: {
        enabled: s.imapAuthMode === 'oauth',
        clientId: resolveOAuthClient({ preset: s.oauthPreset, clientId: s.oauthClientId, tenant: s.oauthTenant }).clientId,
        preset: s.oauthPreset,
        tenant: s.oauthTenant || 'consumers',
        refreshToken: s.oauthRefreshToken,
        scope: s.oauthScope,
        // refresh_token 被微软轮换后立刻落库，避免进程重启后用到旧值
        onRefresh: (next) => this.saveSettings({ oauthRefreshToken: next }),
      },
    };
  }

  #bumpDayCount() {
    const store = this.#store();
    const today = todayKey();
    const dayKey = store?.get?.(KEY.dayKey);
    let count = Number(store?.get?.(KEY.dayCount) || 0);
    if (dayKey !== today) count = 0;
    count += 1;
    store?.set?.(KEY.dayKey, today);
    store?.set?.(KEY.dayCount, String(count));
    return count;
  }

  #todayCount() {
    const store = this.#store();
    const today = todayKey();
    if (store?.get?.(KEY.dayKey) !== today) return 0;
    return Number(store?.get?.(KEY.dayCount) || 0);
  }

  #record(result) {
    const store = this.#store();
    let list = [];
    try {
      list = JSON.parse(store?.get?.(KEY.results) || '[]');
    } catch {
      list = [];
    }
    list.unshift(result);
    store?.set?.(KEY.results, JSON.stringify(list.slice(0, RESULT_CAP)));
    store?.set?.(KEY.lastError, result.ok ? '' : String(result.error || ''));
    store?.set?.(KEY.lastRunAt, String(result.at));
  }

  results() {
    try {
      return JSON.parse(this.#store()?.get?.(KEY.results) || '[]');
    } catch {
      return [];
    }
  }

  status() {
    const s = this.settings();
    const store = this.#store();
    return {
      state: this.state,
      running: this.running,
      step: this.step,
      mode: this.mode,
      profile: this.profileName || null,
      awaitingCode: Boolean(this.pendingCode),
      email: this.currentEmail,
      error: this.error,
      startedAt: this.startedAt || null,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      scheduler: {
        enabled: s.enabled,
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        intervalMin: s.intervalMin,
        dailyMax: s.dailyMax,
        today: this.#todayCount(),
        lastRunAt: Number(store?.get?.(KEY.lastRunAt) || 0) || null,
        lastError: String(store?.get?.(KEY.lastError) || ''),
        inWindow: this.#inWindow(s),
      },
      logs: this.logs.slice(-80).map((x) => ({ at: x.at, line: x.line })),
      results: this.results().slice(0, 15),
    };
  }

  #inWindow(s = this.settings()) {
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const a = minutesOf(s.windowStart, 0);
    const b = minutesOf(s.windowEnd, 24 * 60 - 1);
    return a <= b ? cur >= a && cur <= b : cur >= a || cur <= b; // 支持跨零点
  }

  async runOnce({ email = '', password = '', mode = 'auto' } = {}) {
    this.mode = mode === 'manual' ? 'manual' : 'auto';
    if (this.running) return { ok: false, error: '已有注册任务在进行', ...this.status() };

    // 双号池：过验证码必须用「解题池」的号（它不参与业务请求，所以不会被封）
    const store = this.#tokenStore();
    const solverTokens = (store?.list?.('solver') || []).map((r) => r.token).filter(Boolean);
    if (!solverTokens.length) {
      const err = '解题号池为空：请到「账号」页把一个号移到「解题池」——过人机验证只用这一池，避免主力号被封。';
      this.state = 'failed';
      this.error = err;
      this.#push(`❌ ${err}`);
      return { ok: false, error: err, ...this.status() };
    }
    // 每次跑之前把解题池同步进引擎（后台可能刚改过池）
    try {
      this.engine?.direct?.reloadTokens?.(solverTokens, { allowEmpty: true });
      this.#push(`解题号池：${solverTokens.length} 个号可用`);
    } catch {}

    // 预检：解题池的号如果已经失效，就别开浏览器空等 10 分钟了
    try {
      const probe = await this.engine?.direct?.checkLogin?.({ token: solverTokens[0] });
      // 只有「明确的登录态失效」才吊销；网络抖动（ECONNRESET / 超时）不能算，
      // 否则会把好号误杀（实测把唯一一个解题号干掉了）。
      const reallyInvalid =
        probe &&
        probe.ok === false &&
        (Number(probe.code) === 40003 ||
          /INVALID_TOKEN|TOKEN_EXPIRED|NOT_LOGGED_IN|USER_NOT_FOUND|Authorization Failed/i.test(String(probe.msg || '')));
      if (reallyInvalid) {
        store?.markRevoked?.(solverTokens[0], `解题池预检失败：${probe.msg || probe.code || 'invalid'}`);
        const err = `解题池里的号已失效（${probe.msg || probe.code || 'invalid token'}），请到「账号」页换一个可用号到解题池`;
        this.state = 'failed';
        this.error = err;
        this.#push(`❌ ${err}`);
        return { ok: false, error: err, ...this.status() };
      }
      this.#push('解题池预检通过');
    } catch (err) {
      this.#push(`解题池预检跳过：${err.message}`);
    }

    const s = this.settings();

    // 预检：出口 IP 是否稳定（只提示，不阻断 —— 实测同一出口也可能成功）
    try {
      const exit = await checkExitIp(s.proxy || '', { attempts: 3 });
      if (exit.ok) {
        if (exit.stable) this.#push(`出口 IP：${exit.unique[0]}（稳定）`);
        else {
          this.#push(`⚠️ 出口 IP 不稳定：${exit.unique.join(' → ')}`);
          this.#push('⚠️ 同一会话换 IP 容易被判机器人（biz_code=9/11）');
        }
      }
    } catch (err) {
      this.#push(`出口检查跳过：${err.message}`);
    }

    const candidates = email ? [email.trim()] : this.#aliasCandidates();
    this._aliasQueue = candidates.slice(1);
    const target = candidates[0];

    const pw = password || s.password || `Px${Math.random().toString(36).slice(2, 12)}!9`;

    this.running = true;
    this.state = 'running';
    this.step = '启动浏览器';
    this.error = '';
    this.currentEmail = target;
    this.startedAt = Date.now();
    this.usedCodes = new Set();
    this._codeRetried = Boolean(email && this._codeRetried); // 重试递归时保留标记
    if (!email) this._baseSwitched = false; // 新一轮允许换一次前缀
    this.#push(`开始注册：${target}`);
    this.#push(s.proxy ? `出口代理：${s.proxy}` : '出口：直连（未设置代理）');
    // 实际用的机型号由 session 决定并单独打日志；这里只说明策略
    this.#push('指纹策略：每次随机（池含 Android / iOS / Windows / Linux，共 13 款）');

    let session;
    try {
      session = new VncRegisterSession({
        config: this.config,
        logger: this.logger,
        vnc: false, // 不需要 VNC 观战
        engine: this.engine, // 用号池里的模型答无障碍题
        // 永远随机：DB 里可能残留旧版 UI 写死的指纹（如 windows-amd-rx6700），
        // 绝不能因此每次都同一台机型 —— 那等于把指纹固定住。
        fpSetting: (s.fp && s.fp !== 'random' ? 'random' : s.fp || 'random'),
        codeProvider: async ({ sinceMs, email: who, timeoutMs = 180_000 }) => {
          if (this.mode === 'manual') return [await this.#waitManualCode()];
          this.step = '收取验证码';
          this.#push('等邮箱验证码（只认发码之后到达的邮件，按新→旧依次尝试）');
          const deadline = Date.now() + timeoutMs;
          let lastErr = null;
          while (Date.now() < deadline) {
            // 手动填码优先：后台/接口塞进来的码立刻用，不必等邮件（转发没配好也能跑）
            if (this.pendingCode) {
              const manual = String(this.pendingCode).trim();
              this.pendingCode = null;
              if (manual) {
                this.usedCodes.add(manual);
                this.#push(`使用手动填码 ${manual}`);
                return [manual];
              }
            }
            try {
              const list = await collectCodes({
                cfg: this.#mailCfg(),
                sinceMs,
                expectTo: who || this.currentEmail,
                limit: 3,
                log: (m) => this.#push(m),
              });
              const fresh = list.filter((x) => !this.usedCodes.has(x.code));
              if (fresh.length) {
                for (const x of fresh) this.usedCodes.add(x.code);
                this.#push(
                  `候选验证码（新→旧）：${fresh.map((x) => x.code).join(', ')}｜来源「${fresh[0].subject}」`,
                );
                return fresh.map((x) => x.code);
              }
              if (list.length) this.#push(`只找到已用过的码（${list.map((x) => x.code).join(',')}），继续等新码`);
            } catch (err) {
              lastErr = err;
              this.#push(`收信失败：${err.message}`);
            }
            await new Promise((r) => setTimeout(r, 3000));
          }
          throw new Error(`等验证码超时${lastErr ? `：${lastErr.message}` : ''}`);
        },
      });
      this.session = session;
      session.onSendCode = (at) => { this.lastSendAt = at; };
      this.profileName = session.profileName || null;
      session.onStep = (step) => {
        this.step = step;
        this.#push(`[步骤] ${step}`);
      };

      this.step = '打开注册页';
      await session.start({ email: target, password: pw, proxy: normalizeProxy(s.proxy) || null });

      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const st = session.status();
        if (st.state === 'done') {
          this.state = 'done';
          this.step = '完成';
          this.#bumpDayCount();
          const result = {
            ok: true,
            at: Date.now(),
            email: target,
            token: st.result?.token || '',
            deviceId: st.result?.deviceId || null,
          };
          this.#record(result);
          this.#push(`✅ 注册成功并入池：${target}`);
          // 关键：新号写进数据库后，运行中的引擎并不会自己发现 —— 必须主动热更新，
          // 否则后台显示「池里有号」但转发一直用不到，只能重启。
          try {
            const applied = await this.onTokenAdded?.(target);
            if (applied) this.#push(`主号池已热更新：${applied.tokens ?? '?'} 个 token（无需重启）`);
          } catch (err) {
            this.#push(`主号池热更新失败：${err.message}`);
          }
          this.running = false;
          await session.stop().catch(() => {});
          return { ok: true, ...result, status: this.status() };
        }
        if (st.state === 'failed') {
          throw new Error(st.error || '注册失败');
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error('注册超时（10 分钟）');
    } catch (err) {
      const msg = String(err.message || err);
      // 验证码被判失效（常见于期间又发了一次码）：重发一次，等新码再提交，最多重试 1 次
      if (/EMAIL_VERIFY_FAILED|EMAIL_EXPIRED|biz_code=[78]\b/i.test(msg) && !this._codeRetried) {
        this._codeRetried = true;
        const waitMs = Math.max(0, 62_000 - (Date.now() - (this.lastSendAt || 0)));
        this.#push(`⚠️ 验证码被判失效，等 ${Math.round(waitMs / 1000)}s 过发码冷却后重试一次`);
        this.running = false;
        this.state = 'idle';
        await session?.stop().catch(() => {});
        if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
        return this.runOnce({ email: target, password: pw, mode: this.mode });
      }
      // 邮箱域名/别名形态不被接受：换下一个别名重试（Outlook 的点号别名投同一信箱）
      // biz_code=9：这个邮箱前缀的别名额度用尽了 → 打标，换下一个前缀重试一次
      if (/EMAIL_DOMAIN_NOT_SUPPORTED|biz_code=(4|9)\b/i.test(msg)) {
        const base = String(target).split('@')[0].split('+')[0];
        // 地址池里的完整地址：单独打标，别去烧整个 base
        const store2 = this.#tokenStore();
        const isPooled = String(this.settings().emailPool || '').includes(String(target).toLowerCase());
        if (isPooled) {
          try {
            store2?.set?.(`ADDR_BURN:${String(target).toLowerCase()}`, String(Date.now()));
          } catch {}
          this.#push(`⚠️ 地址 ${target} 已用尽（biz_code 4/9），地址池里换下一个`);
        } else {
          this.#burnBase(base, 'biz_code=9 域名不支持');
        }
        const nextBase = this.#pickBase();
        if (nextBase && nextBase !== base && !this._baseSwitched) {
          this._baseSwitched = true;
          this.running = false;
          this.state = 'idle';
          await session?.stop().catch(() => {});
          this.#push(`换用下一个邮箱前缀：${nextBase}`);
          return this.runOnce({ password: pw, mode: this.mode });
        }
        this.#push('❌ 所有已配置的邮箱前缀都被平台拒绝了 —— 请到设置里补充新的邮箱（emailBases，逗号分隔）');
      }
      this.state = 'failed';
      this.error = msg;
      this.running = false;
      this.#record({ ok: false, at: Date.now(), email: target, error: this.error });
      this.#push(`❌ 失败：${this.error}`);
      await session?.stop().catch(() => {});
      return { ok: false, error: this.error, ...this.status() };
    } finally {
      this.session = null;
    }
  }

  /** 中止当前注册 + 关掉调度 */
  async stop() {
    this.stopScheduler();
    this.saveSettings({ enabled: false });
    if (this.session) {
      await this.session.stop().catch(() => {});
      this.session = null;
    }
    if (this.running) {
      this.running = false;
      this.state = 'idle';
      this.step = '已手动停止';
      this.#push('已手动停止注册');
    }
  }

  /* ---------------- 定时调度 ---------------- */

  startScheduler() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.#tick().catch((err) => this.#push(`调度异常：${err.message}`));
    }, 20_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.#push('定时注册调度已启动（每 20 秒检查一次）');
  }

  stopScheduler() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  schedulerRunning() {
    return Boolean(this.timer);
  }

  async #tick() {
    const s = this.settings();
    if (!s.enabled || this.running) return;
    if (!this.#inWindow(s)) return;
    if (this.#todayCount() >= s.dailyMax) return;
    const last = Number(this.#store()?.get?.(KEY.lastRunAt) || 0);
    if (last && Date.now() - last < s.intervalMin * 60_000) return;
    const mailReady =
      s.imapAuthMode === 'oauth'
        ? Boolean(s.imapUser && s.oauthClientId && s.oauthRefreshToken)
        : Boolean(s.imapUser && s.imapPass);
    if (!mailReady) {
      this.#push(`跳过：IMAP 未配置完整（当前 ${s.imapAuthMode === 'oauth' ? 'OAuth' : '应用密码'} 模式），定时注册必须能自动收码`);
      return;
    }
    await this.runOnce().catch((err) => this.#push(`定时注册失败：${err.message}`));
  }
}
