import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeProxy } from './proxy.mjs';
import { pickProfile } from './fingerprint.mjs';
import { loadPlaywright } from '../browser/playwright.mjs';

/**
 * 「人工过验证」注册会话。
 *
 * 思路：注册流程全部自动化（建邮箱、填表、发码、填码、提交、抓档案），
 * 只有 hCaptcha 那一步交给人——服务器上起一个虚拟桌面 + VNC，
 * 用户用手机/电脑连上去点一下（或拖一下），脚本检测到验证通过就继续往下跑。
 *
 * 为什么这么干：hCaptcha 判的是浏览器指纹 + IP 信誉，
 * 在这台机器上 headless 会被直接回 "Please try again"；
 * 而"人真的看一眼点一下"是唯一稳定过法，且不需要任何打码平台。
 */

const DISPLAY = ':99';
const VNC_PORT = 5901;

export class VncRegisterSession {
  constructor({ config, logger, ask = null, engine = null, vnc = true, codeProvider = null, fpSetting = null, profile = null }) {
    this.config = config;
    this.log = logger;
    /** 是否起 x11vnc（后台「一键注册」不需要观战，省一个进程） */
    this.vnc = vnc;
    /** 外部收码函数：async ({ sinceMs }) => '123456'（自动注册走 IMAP） */
    this.codeProvider = codeProvider;
    /** 指纹策略：'random' 或某个 profile id；传 profile 则直接用展开好的那份 */
    this.fpSetting = fpSetting;
    this.fp = profile;
    /** 进度回调，后台用它显示当前步骤 */
    this.onStep = null;
    /** 可选：自动过 hCaptcha 用的答题函数 / 引擎（不传则保持原「人工过验证」） */
    this.ask = ask;
    this.engine = engine;
    this.state = 'idle';
    this.email = '';
    this.password = '';
    this.box = null;
    this.procs = { xvfb: null, vnc: null };
    this.browser = null;
    this.context = null;
    this.page = null;
    this.result = null;
    this.error = '';
    this.startedAt = 0;
    this.screenshotPath = path.join(config.dataDir, 'register-live.png');
  }

  status() {
    return {
      state: this.state,
      email: this.email,
      vnc: this.state === 'idle' ? null : { host: this.#lanHost(), port: VNC_PORT, display: DISPLAY },
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      screenshot: fs.existsSync(this.screenshotPath) ? '/admin/api/register/screenshot' : null,
      error: this.error,
      result: this.result,
    };
  }

  #lanHost() {
    for (const list of Object.values(osNetworkInterfacesSafe())) {
      for (const item of list || []) {
        if (item.family === 'IPv4' && !item.internal && /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(item.address)) {
          return item.address;
        }
      }
    }
    return '127.0.0.1';
  }

  /** 读真实浏览器版本并生成一致 UA（硬编码版本是设备风控的高危信号） */
  async #buildUA(exe) {
    if (this._ua) return this._ua;
    let major = '156';
    try {
      const { execFileSync } = await import('node:child_process');
      const { chromium } = await loadPlaywright();
      let ver = '';
      if (exe) {
        ver = execFileSync(exe, ['--version'], { encoding: 'utf8' });
      } else {
        const probe = await chromium.launch({ args: ['--no-sandbox'] });
        ver = probe.version();
        await probe.close();
      }
      const m = String(ver).match(/(\d+)\./);
      if (m) major = m[1];
    } catch {}
    if (process.env.DS_FP !== 'desktop') {
      this._ua = `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`;
    } else {
      this._ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    }
    this.log.info(`UA 对齐实际引擎：Chrome/${major}`);
    return this._ua;
  }

  async #startDisplay() {
    // Xvfb
    this.procs.xvfb = spawn('Xvfb', [DISPLAY, '-screen', '0', '1280x900x24', '-nolisten', 'tcp'], {
      stdio: 'ignore',
      detached: false,
    });
    await new Promise((r) => setTimeout(r, 1200));
    if (!this.vnc) {
      this.log.info('跳过 x11vnc（自动注册模式，不需要观战）');
      return;
    }
    // x11vnc（无密码：只在局域网用，且会话结束就杀）
    this.procs.vnc = spawn(
      'x11vnc',
      ['-display', DISPLAY, '-rfbport', String(VNC_PORT), '-forever', '-shared', '-nopw', '-quiet', '-noxdamage'],
      { stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 1200));
    this.log.info(`VNC 已启动：${this.#lanHost()}:${VNC_PORT}（display ${DISPLAY}）`);
  }

  /** 开一次注册会话 */
  async start({ email, password, proxy = null } = {}) {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'failed') {
      throw new Error(`已有会话在跑（${this.state}）`);
    }
    this.state = 'starting';
    this.error = '';
    this.result = null;
    this.startedAt = Date.now();
    try {
      const box = email ? { address: email, password: password || `Px${Math.random().toString(36).slice(2, 12)}!9` } : await this.#makeMailbox();
      this.box = box;
      this.email = box.address;
      this.password = box.password;

      await this.#startDisplay();

      const { chromium } = await loadPlaywright();
      this.proxy = normalizeProxy(proxy || this.config.deepseek.proxies?.[0] || '') || null;
      // 每次都是干净会话：实测同一份 cookie/localStorage 反复注册会被判
      // RISK_DEVICE_DETECTED（人工遇到同样情况，清掉就能过）。所以这里：
      //   1) 用非持久化 context（等价于全新 profile）
      //   2) 进页面前再显式清一次 cookie / localStorage / sessionStorage
      //   3) UA 对齐真实引擎版本，避免版本号对不上
      const exe = process.env.DS_CHROME || '';
      const ua = await this.#buildUA(exe);
      this.browser = await chromium.launch({
        headless: false,
        ...(exe ? { executablePath: exe } : {}),
        ...(this.proxy ? { proxy: { server: this.proxy } } : {}),
        env: { ...process.env, DISPLAY },
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US', '--start-maximized'],
      });
      // 移动端伪装：与「真机注册成功」的指纹对齐（Android + 高通 GPU + dpr3 + 5 点触控）
      // 设备指纹：每次随机挑一台真实机型（也可用 DS_FP_PROFILE 固定）
      const fpSetting = this.fpSetting || process.env.DS_FP_PROFILE || 'random';
      const majorFromUa = (ua.match(/Chrome\/(\d+)/) || [])[1];
      if (this.fp) {
        // 外部已经给了一份展开好的指纹，直接用
        this.fp = this.fp;
      } else {
        const picked = pickProfile(fpSetting, { chromeMajor: majorFromUa || '156', width: 1280, height: 900 });
        this.fp = picked.expanded;
        this.profileName = picked.profile.id;
      }
      this.log.info(`设备指纹：${this.fp.id}（${this.fp.label}）`);

      this.context = await this.browser.newContext({
        viewport: this.fp.viewport,
        screen: this.fp.viewport,
        deviceScaleFactor: this.fp.dpr,
        hasTouch: this.fp.hasTouch,
        locale: process.env.DS_UI_LOCALE || 'en-US',
        timezoneId: 'Asia/Shanghai',
        userAgent: this.fp.ua,
      });
      await this.context.clearCookies().catch(() => {});
      // 覆盖真机特有的几个可读属性（Chromium 在 Linux 上给的是 Linux x86_64 / SwiftShader）
      await this.context.addInitScript((fp) => {
        const def = (obj, key, value) => {
          try {
            Object.defineProperty(obj, key, { get: () => value, configurable: true });
          } catch {}
        };
        const mobile = fp.kind === 'mobile';
        def(Navigator.prototype, 'platform', fp.platform);
        def(Navigator.prototype, 'maxTouchPoints', fp.maxTouchPoints);
        def(Navigator.prototype, 'pdfViewerEnabled', fp.pdfViewerEnabled);
        // 插件列表：移动端为空
        try {
          Object.defineProperty(Navigator.prototype, 'plugins', { get: () => Object.setPrototypeOf([], PluginArray.prototype), configurable: true });
          Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => Object.setPrototypeOf([], MimeTypeArray.prototype), configurable: true });
        } catch {}

        // WebGL：把 SwiftShader 换成真机 GPU 字符串
        const GPU = {
          vendor: 'WebKit',
          renderer: 'WebKit WebGL',
          unmaskedVendor: fp.gpu.unmaskedVendor,
          unmaskedRenderer: fp.gpu.unmaskedRenderer,
        };
        const origGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p) {
          // UNMASKED_VENDOR_WEBGL 0x9245 / UNMASKED_RENDERER_WEBGL 0x9246
          if (p === 0x9245) return GPU.unmaskedVendor;
          if (p === 0x9246) return GPU.unmaskedRenderer;
          if (p === 0x1f00) return GPU.vendor;   // VENDOR
          if (p === 0x1f01) return GPU.renderer; // RENDERER
          if (p === 0x0d3a) return new Int32Array([16384, 16384]); // MAX_VIEWPORT_DIMS
          return origGetParameter.call(this, p);
        };
        if (window.WebGL2RenderingContext) {
          const o2 = WebGL2RenderingContext.prototype.getParameter;
          WebGL2RenderingContext.prototype.getParameter = function (p) {
            if (p === 0x9245) return GPU.unmaskedVendor;
            if (p === 0x9246) return GPU.unmaskedRenderer;
            return o2.call(this, p);
          };
        }
        // UA-CH：CDP 的 userAgentMetadata 在 Linux Chromium 上不生效（userAgentData 直接为 null），
        // 这里按指纹对象自建一个等价实现，保证 brands / platform / model 全自洽。
        const meta = fp.uaData;
        if (meta) try {
          const uad = {
            brands: meta.brands,
            mobile: meta.mobile,
            platform: meta.platform,
            getHighEntropyValues: async (hints) => {
              const out = {};
              for (const h of hints) out[h] = meta[h];
              return out;
            },
            toJSON: () => ({ brands: meta.brands, mobile: meta.mobile, platform: meta.platform }),
          };
          Object.defineProperty(Navigator.prototype, 'userAgentData', { get: () => uad, configurable: true });
        } catch {}
        // iOS（CriOS/WebKit）本来就没有 navigator.userAgentData，别画蛇添足
      }, this.fp);

      this.page = await this.context.newPage();
      /** 最近一次 register 接口的响应（用于把 biz_code 翻译成人话） */
      this.registerApi = null;
      /** 真实发出过几次发码请求（以接口响应为准，比点按钮可靠） */
      this.sendCount = 0;
      this.lastSendAt = 0;
      this.page.on('response', async (res) => {
        if (!/\/api\/v0\/users\/create_email_verification_code/.test(res.url())) return;
        let body = '';
        try { body = await res.text(); } catch {}
        let parsed = null;
        try { parsed = JSON.parse(body); } catch {}
        if (/\/api\/v0\/users\/register/.test(res.url())) {
          this.log.info(`register 原始响应：${body.slice(0, 220)}`);
        }
        // 只有「真的发出去了」才算一次：40303 那种挑战响应也叫这个接口，但没发信
        const reallySent = parsed?.data?.biz_code === 0 && Boolean(parsed?.data?.biz_data?.send_window_secs);
        if (reallySent) {
          this.sendCount += 1;
          this.lastSendAt = Date.now();
          this.log.info(
            `发码成功 #${this.sendCount}（${new Date(this.lastSendAt).toISOString()}，窗口 ${parsed.data.biz_data.send_window_secs}s）`,
          );
        } else {
          const biz = parsed?.data?.biz_code;
          const bmsg = String(parsed?.data?.biz_msg || '');
          this.log.info(`发码接口返回但未发信（biz_code=${biz ?? '?'} biz_msg=${bmsg}）`);
          // 域名/邮箱不被接受：再等验证码是白等，直接记下来让上层立刻失败
          if (Number(biz) === 4 || /EMAIL_DOMAIN_NOT_SUPPORTED|DOMAIN_NOT_SUPPORTED/i.test(bmsg)) {
            this.sendRejected = { code: biz, msg: bmsg || 'EMAIL_DOMAIN_NOT_SUPPORTED' };
          }
        }
      });
      this.page.on('response', async (res) => {
        if (!/\/api\/v0\/users\/register/.test(res.url())) return;
        let body = '';
        try {
          body = await res.text();
        } catch {}
        let parsed = null;
        try {
          parsed = JSON.parse(body);
        } catch {}
        this.registerApi = { at: Date.now(), status: res.status(), body: body.slice(0, 400), parsed };
        const biz = parsed?.data?.biz_code;
        this.log.info(`register 响应：http=${res.status()} biz_code=${biz} biz_msg=${parsed?.data?.biz_msg || ''}`);
      });
      // Chromium(Debian) 的 UA-CH 是 "Not:A-Brand"/"Chromium"，没有 "Google Chrome" 品牌，
      // 也没有 full-version-list/arch/bitness/wow64 —— 真 Chrome 一定有，这是设备风控的强信号。
      // 只能走 CDP 覆盖（Playwright 的 userAgent 选项管不到 sec-ch-ua-*）。
      try {
        const major = (ua.match(/Chrome\/(\d+)/) || [])[1] || '156';
        const full = process.env.DS_UA_FULL || `${major}.0.8078.79`;
        const client = await this.context.newCDPSession(this.page);
        const md = this.fp.uaData;
        await client.send('Emulation.setUserAgentOverride', {
          userAgent: this.fp.ua,
          acceptLanguage: (process.env.DS_UI_LOCALE || 'en-US').startsWith('zh') ? 'zh-CN,zh' : 'en-US,en',
          platform: this.fp.platform,
          ...(md ? { userAgentMetadata: {
            brands: md.brands,
            fullVersionList: md.fullVersionList,
            fullVersion: md.uaFullVersion,
            platform: md.platform,
            platformVersion: md.platformVersion,
            architecture: md.architecture,
            model: md.model,
            mobile: md.mobile,
            bitness: md.bitness,
            wow64: md.wow64,
          } } : {}),
        });
        this.log.info(`指纹已应用（${this.fp.id}${this.fp.uaData ? ` · UA-CH ${this.fp.uaData.platform}` : ' · 无 UA-CH（iOS）'}）`);
      } catch (e) {
        this.log.warn('UA-CH 覆盖失败:', e.message);
      }
      // 注意：不要在 addInitScript 里清 storage —— WAF 挑战会整页重载，
      // 每加载一次就清一次会让 device_id 反复重生，反而更容易判 RISK_DEVICE_DETECTED
      this.state = 'loading';
      this.onStep?.('打开注册页');
      // DS_FP_CHECK=1：只采指纹就退出，用于验证伪装是否生效（不消耗验证码）
      if (process.env.DS_FP_CHECK === '1') {
        const { COLLECT } = await import('../captcha/fp.mjs');
        const fp = await this.page.evaluate(COLLECT);
        this.log.info('FINGERPRINT ' + JSON.stringify({
          ua: fp.basic.userAgent.slice(0, 90),
          platform: fp.basic.platform,
          touch: fp.basic.maxTouchPoints,
          pdf: fp.basic.pdfViewerEnabled,
          langs: fp.basic.languages,
          screen: `${fp.screen.w}x${fp.screen.h}@${fp.screen.dpr}`,
          plugins: fp.window.plugins,
          gpu: [fp.webgl.unmaskedVendor, fp.webgl.unmaskedRenderer],
          uaData: [fp.uaData?.platform, fp.uaData?.brands, fp.uaData?.high?.model],
          fonts: fp.fonts,
        }));
        throw new Error('FP_CHECK_DONE');
      }

      if (this.proxy) this.log.info(`注册会话走代理：${this.proxy}`);
      await this.page.goto(`${this.config.deepseek.baseUrl}/sign_up`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      // 等页面真正渲染出表单（AWS WAF 挑战 + 地区判定都需要时间，6 秒不够）
      const readyDeadline = Date.now() + 40_000;
      while (Date.now() < readyDeadline) {
        const hasEmail = await this.page
          .locator('input[type="text"], input:not([type])')
          .first()
          .isVisible()
          .catch(() => false);
        if (hasEmail) break;
        await this.page.waitForTimeout(1500);
      }

      // 关 cookie 弹窗
      await this.page.getByText(/仅接受必要 Cookies|Necessary cookies only/).first().click({ timeout: 3000 }).catch(() => {});

      // 地区判定：只有"确实没有邮箱输入框"才判为手机号专属（页面文案可能是 WAF 前的占位）
      const emailInputVisible = await this.page
        .locator('input[type="text"], input:not([type])')
        .first()
        .isVisible()
        .catch(() => false);
      const phones = await this.page.getByText(/仅支持手机号注册|Only phone registration/).count().catch(() => 0);
      const pageText = (await this.page.evaluate(() => document.body.innerText).catch(() => ''))
        .replace(/\s+/g, ' ')
        .slice(0, 120);
      this.log.info(`注册页：${pageText}`);
      if (phones && !emailInputVisible) {
        throw new Error('当前出口只允许手机号注册，请换出口（比如你家宽）再试');
      }

      // 地区判定：代理池会轮换到「仅手机号注册」的国家，这里直接给出人话错误，
      // 不要傻等到 fill 超时（之前就是这样白等 15 秒）
      const pageText0 = await this.page.evaluate(() => document.body.innerText).catch(() => '');
      if (/Only phone number registration|仅支持手机号注册/i.test(pageText0)) {
        const via = this.proxy ? `代理 ${this.proxy}` : '直连（未设置代理）';
        throw new Error(`当前出口${via}所在地区仅支持手机号注册，请换到支持邮箱注册的节点（如德国），或在后台配置并保存代理`);
      }

      // 填邮箱 + 密码
      await this.page.locator('input[type="text"], input:not([type])').first().fill(this.email, { timeout: 15_000 });
      // 注册页有「密码 / 确认密码」两个 password 输入框，必须都填
      const pwInputs = this.page.locator('input[type="password"]');
      const pwCount = await pwInputs.count().catch(() => 0);
      for (let i = 0; i < pwCount; i += 1) {
        await pwInputs.nth(i).fill(this.password, { timeout: 15_000 }).catch(() => {});
      }
      this.log.info(`已填 ${pwCount} 个密码框`);
      this.state = 'waiting_captcha';
      this.onStep?.('等待人机验证');
      this.log.info(`注册会话已就绪：${this.email}，等人工过验证`);

      // 后台推进：等验证通过 → 发码 → 收码 → 填码 → 提交
      this.#drive().catch((err) => {
        this.error = err.message;
        this.state = 'failed';
        this.log.warn(`注册会话失败：${err.message}`);
      });
      return this.status();
    } catch (err) {
      this.error = err.message;
      this.state = 'failed';
      await this.stop().catch(() => {});
      throw err;
    }
  }

  async #makeMailbox() {
    const doms = (await (await fetch('https://api.mail.tm/domains')).json())['hydra:member'] || [];
    for (const d of doms) {
      const address = `ds${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@${d.domain}`;
      const password = `Px${Math.random().toString(36).slice(2, 12)}!9`;
      const acc = await fetch('https://api.mail.tm/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, password }),
      }).then((r) => r.json());
      if (!acc.id) continue;
      const tok = await fetch('https://api.mail.tm/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, password }),
      }).then((r) => r.json());
      return { address, password, mailToken: tok.token };
    }
    throw new Error('建临时邮箱失败');
  }

  /** 轮询：hCaptcha 是否已通过（textarea 有值 / 挑战框消失） */
  /** 精确定位验证码输入框：placeholder / name / 类型 都带提示的不行就返回 null */
  async #findCodeInput() {
    const candidates = [
      'input[placeholder*="Code" i]',
      'input[placeholder*="验证码"]',
      'input[name*="code" i]',
      'input[type="tel"]',
      'input[maxlength="6"]',
    ];
    for (const sel of candidates) {
      const el = await this.page.$(sel).catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) return el;
    }
    return null;
  }

  /** 保证邮箱框里还是我们要注册的地址；被改坏就重新填回去 */
  async #ensureEmailField(email) {
    if (!email) return;
    const inputs = await this.page.$$('input').catch(() => []);
    for (const el of inputs) {
      const type = await el.getAttribute('type').catch(() => '');
      const ph = (await el.getAttribute('placeholder').catch(() => '')) || '';
      if (type === 'password') continue;
      const isEmail = /mail|邮箱/i.test(ph) || type === 'email';
      if (!isEmail) continue;
      const value = await el.inputValue().catch(() => '');
      if (value.trim().toLowerCase() !== email.toLowerCase()) {
        this.log.warn(`邮箱框被改动（"${value}" → "${email}"），已重新填入`);
        await el.fill(email).catch(() => {});
      }
      return;
    }
  }

  async #waitCaptchaSolved(timeoutMs = 15 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state === 'failed') return false;
      const solved = await this.page
        .evaluate(() => {
          const el = document.querySelector('textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"]');
          if (el && el.value && el.value.length > 20) return true;
          return false;
        })
        .catch(() => false);
      if (solved) return true;
      await this.page.waitForTimeout(1500);
    }
    return false;
  }

  async #waitCode(mailToken, timeoutMs = 5 * 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const list = await fetch('https://api.mail.tm/messages', { headers: { authorization: `Bearer ${mailToken}` } })
        .then((r) => r.json())
        .catch(() => ({}));
      for (const msg of list['hydra:member'] || []) {
        const mail = await fetch(`https://api.mail.tm/messages/${msg.id}`, {
          headers: { authorization: `Bearer ${mailToken}` },
        })
          .then((r) => r.json())
          .catch(() => null);
        const hit = JSON.stringify(mail || {}).match(/\b(\d{6})\b/);
        if (hit) return hit[1];
      }
      await this.page.waitForTimeout(3000);
    }
    return null;
  }

  /**
   * 自动过 hCaptcha：走「无障碍挑战」纯文本问答（见 src/captcha/a11y.mjs）。
   * 成功返回 true；不可用或失败返回 false，让上层退回人工 VNC。
   */
  async #tryAutoCaptcha() {
    const env = process.env;
    const httpCfg = {
      base: env.A11Y_LLM_BASE || '',
      key: env.A11Y_LLM_KEY || '',
      model: env.A11Y_LLM_MODEL || '',
    };
    const hasHttp = httpCfg.base && httpCfg.model;
    if (!this.ask && !this.engine && !hasHttp) return false;

    const { solveA11y, makeAsk, makeHttpAsk, loadCache } = await import('../captcha/a11y.mjs');
    try {
      // 先点一次发码，把 hCaptcha 挑战弹出来；这一刻就是「验证码开始计时」的起点
      this.codeRequestedAt = Date.now();
      await this.page
        .getByText(/发送验证码|Send code/)
        .first()
        .click({ timeout: 10_000 })
        .catch(() => {});
      this.state = 'auto_captcha';
      const cache = loadCache();
      const ask =
        this.ask ||
        (this.engine
          ? makeAsk({ engine: this.engine, cache, log: this.log })
          : makeHttpAsk({ ...httpCfg, cache, log: this.log }));
      const { token, stats } = await solveA11y(this.page, { ask, log: this.log });
      this.log.info(`hCaptcha 自动通过（无障碍题 ${stats.questions.length} 道）`);
      return !!token;
    } catch (err) {
      this.log.warn(`自动过验证失败，退回人工：${err.message}`);
      return false;
    }
  }

  /** 人工收尾模式：填好表单 → 自动过 hCaptcha → 发码 → 等人在 VNC 里填码点注册 → 抓 token */
  async #driveManual() {
    this.state = 'manual';
    this.log.info(`人工收尾模式：先自动过 hCaptcha 并触发发码`);
    const ok = await this.#tryAutoCaptcha();
    if (!ok) {
      this.log.warn('自动过验证失败 —— 请在 VNC 里手动过验证并点 Send code');
    }
    this.log.info(`请在 VNC ${this.#lanHost()}:${VNC_PORT} 里填入邮箱验证码并点 Sign up（最长 15 分钟）`);
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const token = await this.page
        .evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken');
            if (!raw) return '';
            const v = JSON.parse(raw).value;
            return typeof v === 'string' ? v : v?.jwt || '';
          } catch { return ''; }
        })
        .catch(() => '');
      if (token) {
        const { parseProfile } = await import('../profile.mjs');
        const { openTokenStore } = await import('../token-store.mjs');
        const storage = await this.page.evaluate(() => {
          const out = {};
          for (let i = 0; i < localStorage.length; i += 1) {
            const k = localStorage.key(i);
            out[k] = localStorage.getItem(k);
          }
          return out;
        }).catch(() => ({}));
        const profile = parseProfile(storage);
        openTokenStore({ dataDir: this.config.dataDir }).add(token, {
          source: 'manual-vnc',
          deviceId: profile.deviceId || null,
          note: this.email,
        });
        this.result = { email: this.email, token: `${token.slice(0, 6)}…`, deviceId: profile.deviceId || null };
        this.state = 'done';
        this.log.info(`✅ 注册成功并已入池：${this.email}`);
        return;
      }
      await this.page.waitForTimeout(2000);
    }
    throw new Error('人工收尾超时（15 分钟）');
  }

  /** 主流程：先尝试自动过验证，不行再等人工 → 自动完成剩余步骤 */
  async #drive() {
    if (process.env.DS_MANUAL === '1') return this.#driveManual();
    const auto = await this.#tryAutoCaptcha();
    if (!auto) {
      // 无障碍自动解失败时，最多再等 60 秒看是不是平台自己放行；
      // 之前这里会干等 15 分钟，表现成「一直卡在等待人机验证」。
      this.log.warn('无障碍自动解失败，最多再等 60 秒（不会无限等）');
      if (!(await this.#waitCaptchaSolved(60_000))) {
        throw new Error('人机验证未通过：无障碍题自动解失败（多为解题池里的号已失效），请换一个可用号到解题池后重试');
      }
    }

    this.state = 'sending_code';
    this.onStep?.('发送验证码');
    // 只要平台已经发过码（有真实接口响应），就绝不再点第二次
    const autoSent = this.sendCount > 0 || Boolean(auto && this.codeRequestedAt);
    if (process.env.DS_SKIP_SEND === '1') {
      this.log.info('DS_SKIP_SEND=1：跳过发码（沿用已发出的验证码）');
    } else if (autoSent) {
      this.log.info(`平台已发码 ${this.sendCount} 次，跳过重复点击（避免 60s 限流与旧码作废）`);
    } else {
      await this.page.getByText(/发送验证码|Send code/).first().click({ timeout: 15_000 }).catch(() => {});
      this.sendCount = (this.sendCount || 0) + 1;
      this.codeRequestedAt = Date.now();
      this.log.info(`点击发送验证码（第 ${this.sendCount} 次），旧码此刻作废`);
    }
    if (this.sendRejected) {
      throw new Error(
        `发码被拒：邮箱域名不被接受（biz_code=${this.sendRejected.code} ${this.sendRejected.msg}）——` +
          `临时邮箱/非常规域名不支持，请换 gmail/outlook/hotmail/yahoo`,
      );
    }

    // 关键：只认「第一次请求发码之后」到达的邮件。之前给了 3 分钟回看窗口，
    // 新码还没到就把上一封的旧码当成命中，注册必然失败。
    const sentAt = this.lastSendAt || this.codeRequestedAt || Date.now();
    this.log.info(`收码窗口起点：${new Date(sentAt).toISOString()}（平台累计发码 ${this.sendCount} 次），只接受此后的邮件`);

    let code = null;
    let codeCandidates = [];
    if (this.codeProvider) {
      this.state = 'waiting_code';
      this.onStep?.('收取验证码');
      try {
        // 拿「候选列表」（最新优先），按顺序去试 —— 不猜哪个更新，让服务端判定
        const got = await this.codeProvider({ sinceMs: sentAt, email: this.email });
        codeCandidates = Array.isArray(got) ? got.filter(Boolean) : [got].filter(Boolean);
        code = codeCandidates[0];
        if (codeCandidates.length > 1) {
          this.log.info(`收到 ${codeCandidates.length} 个候选验证码，按新→旧依次尝试：${codeCandidates.join(', ')}`);
        }
      } catch (err) {
        throw new Error(`收码失败：${err.message}`);
      }
    } else if (this.box?.mailToken) {
      this.state = 'waiting_code';
      code = await this.#waitCode(this.box.mailToken);
    } else if (process.env.DS_CODE_FILE) {
      // 外部邮箱（如 outlook）收码：轮询一个文本文件，人工/外部脚本把 6 位码写进去
      this.state = 'waiting_code';
      const fsx = await import('node:fs');
      const deadline = Date.now() + 8 * 60_000;
      while (Date.now() < deadline) {
        const raw = fsx.existsSync(process.env.DS_CODE_FILE)
          ? fsx.readFileSync(process.env.DS_CODE_FILE, 'utf8')
          : '';
        const hit = raw.match(/\b(\d{6})\b/);
        if (hit) { code = hit[1]; fsx.writeFileSync(process.env.DS_CODE_FILE, ''); break; }
        await this.page.waitForTimeout(1500);
      }
      this.log.info(`外部邮箱验证码：${code || '未收到'}`);
    }
    if (!code) throw new Error('没收到邮箱验证码（可手动填）');
    this.log.info(`收到验证码 ${code}，提交注册`);

    // 只填验证码输入框：优先 placeholder=Code / type=tel，其次最后一个输入框。
    // 之前的写法会把验证码灌进所有 text 输入框（邮箱框就是 type=text），直接把邮箱改坏。
    const codeInput =
      (await this.page.$('input[placeholder*="Code" i], input[type="tel"]').catch(() => null)) ||
      (await this.page.$$('input')).at(-1);
    if (!codeInput) throw new Error('找不到验证码输入框');
    await codeInput.fill(code).catch(() => {});
    // 保险：确认邮箱字段还在
    const emailStillThere = await this.page
      .$eval('input[type="text"], input:not([type])', (el) => el.value)
      .catch(() => '');
    if (emailStillThere && emailStillThere !== this.email) {
      this.log.warn(`邮箱字段被覆盖（${emailStillThere}），重新填回`);
      await this.page
        .$eval('input[type="text"], input:not([type])', (el, v) => { el.value = v; }, this.email)
        .catch(() => {});
      await this.page.locator('input[type="text"], input:not([type])').first().fill(this.email).catch(() => {});
    }
    this.state = 'submitting';
    this.onStep?.('提交注册');
    // 勾同意条款（不勾的话前端直接拦下，register 请求根本不会发出）
    const agree = await this.page.$('input[type="checkbox"]').catch(() => null);
    if (agree) {
      const checked = await agree.isChecked().catch(() => false);
      if (!checked) await agree.click({ force: true }).catch(() => {});
      this.log.info(`同意条款勾选：${await agree.isChecked().catch(() => '?')}`);
    } else {
      this.log.warn('没找到同意条款的 checkbox（可能已在别处）');
    }
    // 按候选码依次提交：服务端说「验证码失效」就换下一个，绝不重发（重发会让旧码全废）
    const tryCodes = (codeCandidates.length ? codeCandidates : code ? [code] : []).slice(0, 2);
    for (let i = 0; i < tryCodes.length; i += 1) {
      const attemptCode = tryCodes[i];
      this.registerApi = null;
      try {
        // 只认真正像"验证码"的输入框，绝不拿"最后一个 input"兜底
        const codeInput2 = await this.#findCodeInput();
        if (!codeInput2) throw new Error('找不到验证码输入框');
        await codeInput2.fill(String(attemptCode));

        // 关键：确认邮箱框没被改坏（之前填错框会把邮箱污染成非法地址 → biz_code=9）
        await this.#ensureEmailField(this.email);
      } catch (err) {
        this.log.warn(`填码失败：${err.message}`);
      }
      // 提交前把表单真实值打出来（邮箱/验证码是否错位，一眼可见）
      try {
        const snap = await this.page.evaluate(() =>
          [...document.querySelectorAll('input')].map((el) => ({
            ph: el.placeholder || el.type,
            v: el.value || '',
            t: el.type,
          })),
        );
        this.log.info(
          `提交前表单：${JSON.stringify(snap.map((x) => ({ field: x.ph, value: x.t === 'password' ? '***' : x.v })))}`,
        );
      } catch {}
      this.log.info(`提交验证码 ${attemptCode}（第 ${i + 1}/${tryCodes.length} 个候选）`);
      await this.page.getByText(/^Sign up$|^注册$/).first().click({ timeout: 15_000 }).catch(() => {});

      // 等 register 的响应（最多 12 秒）
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && !this.registerApi) await this.page.waitForTimeout(300);

      const biz = this.registerApi?.parsed?.data?.biz_code;
      const pageAfter = await this.page.evaluate(() => document.body.innerText).catch(() => '');
      this.log.info(
        `提交结果：biz_code=${biz ?? '?'} ${this.registerApi?.parsed?.data?.biz_msg || ''}｜页面：${String(pageAfter).replace(/\n/g, ' | ').slice(0, 100)}`,
      );
      // 成功（或不是验证码问题）就跳出，交给后面的抓登录态
      if (biz !== 8) break;
      this.log.warn(`验证码 ${attemptCode} 被判失效，换下一个候选（不重发）`);
    }
    await this.page.waitForTimeout(3000);

    // 抓登录态
    this.state = 'capturing';
    this.onStep?.('抓取登录态');
    const storage = await this.page
      .evaluate(() => {
        const out = {};
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      })
      .catch(() => ({}));
    const token = await this.page
      .evaluate(() => {
        try {
          const raw = localStorage.getItem('userToken');
          const v = raw ? JSON.parse(raw).value : null;
          return typeof v === 'string' ? v : v?.jwt || '';
        } catch {
          return '';
        }
      })
      .catch(() => '');

    if (!token) {
      const BIZ = {
        0: '成功',
        1: '这个邮箱已经注册过了（ACCOUNT_ALREADY_EXISTS），换一个新的别名',
        7: '验证码已过期（EMAIL_EXPIRED）—— 从发码到提交超过有效期，重发一次即可',
        8: '验证码不对或已过期（EMAIL_VERIFY_FAILED）—— 每发一次码旧码作废',
        9: '邮箱域名/地址不被接受（EMAIL_DOMAIN_NOT_SUPPORTED）',
        11: '被设备风控拦下（RISK_DEVICE_DETECTED）：当前浏览器指纹/IP 被判风险',
        13: '缺少签名（SIGNATURE_REQUIRED）',
        14: '需要邮箱二次验证（MFA_VERIFICATION_CODE_REQUIRED）',
      };
      const biz = this.registerApi?.parsed?.data?.biz_code;
      const msg = this.registerApi?.parsed?.data?.biz_msg || '';
      const hint = BIZ[biz] || (msg ? `register 返回 ${msg}` : '没有捕获到 register 响应');
      throw new Error(`注册未成功：${hint}（biz_code=${biz ?? '?'}）`);
    }

    // 落盘：只入号池（真人档案链路已砍掉，不再往 data/profiles/ 写快照——
    // 写了也没有消费方，浏览器启动时不再注入任何 localStorage）
    const { parseProfile } = await import('../profile.mjs');
    const { openTokenStore } = await import('../token-store.mjs');
    const profile = parseProfile(storage);
    const store = openTokenStore({ dataDir: this.config.dataDir });
    store.add(token, { source: 'vnc-register', deviceId: profile.deviceId || null, note: this.email });

    this.result = {
      email: this.email,
      password: this.password,
      token: `${token.slice(0, 6)}…`,
      deviceId: profile.deviceId || null,
    };
    this.state = 'done';
    this.log.info(`✅ 注册成功：${this.email}（device ${profile.deviceId || '未知'}）`);
  }

  /** 截图（给后台看当前状态） */
  async screenshot() {
    if (!this.page) return null;
    await this.page.screenshot({ path: this.screenshotPath }).catch(() => {});
    return fs.existsSync(this.screenshotPath) ? this.screenshotPath : null;
  }

  async stop() {
    for (const p of [this.browser]) {
      try {
        await p?.close?.();
      } catch {}
    }
    for (const key of ['vnc', 'xvfb']) {
      try {
        this.procs[key]?.kill('SIGTERM');
      } catch {}
      this.procs[key] = null;
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    if (this.state !== 'done') this.state = 'idle';
  }
}

function osNetworkInterfacesSafe() {
  try {
    return os.networkInterfaces();
  } catch {
    return {};
  }
}
