import fs from 'node:fs';
import path from 'node:path';

import { solveUntilGone, humanClick } from '../captcha/shumei.mjs';
import { waitForCode, mailConfigured, readMailConfig } from '../mail/mailbox.mjs';

/**
 * 全自动登录：真浏览器 + 真人节奏 + 数美点选 + 邮箱验证码。
 *
 * 链路（实测）：
 *   1. 打开首页；已登录 → 直接取 token（localStorage.userToken.value）
 *   2. 否则点「密码登录」→ 填邮箱/密码 → 点「登录」
 *   3. 服务端可能返回三种结果：
 *        a) 直接进入聊天页            → biz_code 0，拿到 token
 *        b) biz_code 14（MFA）        → 要邮箱验证码
 *        c) 数据层 422 body.device_id → 数美设备号还没生成，等一会儿再提交
 *   4. MFA 分支：点「发送验证码」→ 可能弹数美点选（用 OpenCV 解）→
 *      读邮箱拿 6 位码 → 填写 → 点「验证并登录」
 *   5. 成功后把 localStorage 全量 + token 交给调用方落盘（这就是「注入 token」）
 *
 * 关键：整条链路不产生合成事件。打字用 page.keyboard（CDP），
 * 点击用 page.mouse（CDP），因此 isTrusted 全为 true，数美的行为采集是真实数据。
 */

const TOKEN_KEY = 'userToken';
const DID_KEY = 'deepseek-device-id:chat';

/**
 * 界面文案候选（中英双语兜底）。
 *
 * 网页按浏览器 locale 渲染文案：默认已经钉成 zh-CN，但只要哪天语言又变回英文
 * （风控改版 / locale 没生效 / A-B 测试），只认中文文案就会直接抛「找不到按钮」。
 * 所以这里把两种语言都列上，命中任一即可。
 */
const LABELS = {
  passwordLogin: ['密码登录', '密码登录/注册', 'Password login', 'Password Login', 'Sign in with password'],
  login: ['登录', 'Log in', 'Login', 'Sign in'],
  sendCode: ['发送验证码', 'Send code', 'Send Code', 'Send verification code'],
  verifyAndLogin: [
    '验证并登录',
    'Verify and log in',
    'Verify and sign in',
    'Verify code and log in',
    'Verify and Log In',
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/** 逐字输入；长文本（>400）改成一次 insertText，等价于真人粘贴 */
async function typeHuman(page, text, { min = 45, max = 130 } = {}) {
  if (text.length > 400) {
    await page.keyboard.insertText(text);
    await sleep(rand(150, 450));
    return;
  }
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(rand(min, max));
    if (Math.random() < 0.03) await sleep(rand(300, 800));
  }
}

/** 找可点击元素：先按 role，再退化到带 ds-button 的 div（站内按钮不是 <button>） */
async function clickByText(page, text, { exact = true, timeout = 8000 } = {}) {
  const tries = [
    () => page.getByRole('button', { name: text, exact }).first(),
    () => page.locator('div.ds-button', { hasText: text }).last(),
    () => page.getByText(text, { exact }).last(),
  ];
  for (const make of tries) {
    const loc = make();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout });
        return true;
      } catch {
        /* 换下一个选择器 */
      }
    }
  }
  return false;
}

/**
 * 多语言兜底点击：界面文案会跟着 locale 变（zh-CN 是中文，兜底还可能回英文），
 * 任何一个候选命中就点。全部落空才返回 false，交给调用方决定。
 */
async function clickByTexts(page, texts, { exact = true, timeout = 8000 } = {}) {
  const labels = (Array.isArray(texts) ? texts : [texts]).filter(Boolean);
  for (const label of labels) {
    if (await clickByText(page, label, { exact, timeout })) return label;
  }
  return false;
}

async function readStorage(page) {
  return page.evaluate(() => {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i);
        out[k] = localStorage.getItem(k);
      }
    } catch {
      /* ignore */
    }
    return out;
  });
}

function parseTokenValue(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.value === 'string') return obj.value;
  } catch {
    /* 纯字符串 token */
  }
  return typeof raw === 'string' && raw.length > 20 ? raw : null;
}

export async function readToken(page) {
  const storage = await readStorage(page);
  return {
    token: parseTokenValue(storage[TOKEN_KEY]),
    deviceId: storage[DID_KEY] || null,
    storage,
  };
}

/** 页面状态判定 */
async function pageState(page) {
  return page
    .evaluate(() => {
      const text = document.body.innerText || '';
      return {
        url: location.pathname,
        signedIn: Boolean(localStorage.getItem('userToken')),
        hasTextarea: Boolean(document.querySelector('textarea')),
        passwordForm: Boolean(document.querySelector('input[type=password]')),
        // 中英双语：MFA / 人机验证的提示文案两种语言都认
        mfa: /验证账号|为保护账号安全|verify your account|protect your account/i.test(text),
        captcha: /点击图中|请选择图中|请依次点击|select the images?|select all (the )?(images?|pictures?)|complete the verification/i.test(text),
        signedOut: /\/sign_in/.test(location.pathname),
      };
    })
    .catch(() => ({ url: '', signedIn: false }));
}

/**
 * 主流程。
 * @param {import('playwright').Page} page
 * @param {{email:string,password:string,log?:Function,onProgress?:Function,mail?:object,signal?:AbortSignal}} opts
 */
export async function loginWithBrowser(page, opts) {
  const { email, password, log = () => {}, onProgress = () => {}, signal } = opts;
  const mail = opts.mail ?? readMailConfig();
  const check = () => {
    if (signal?.aborted) throw new Error('登录已取消');
  };

  log('打开 chat.deepseek.com');
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(rand(4000, 6500));

  let st = await pageState(page);
  if (st.signedIn && st.hasTextarea) {
    const { token, storage, deviceId } = await readToken(page);
    log('已有登录态，直接复用');
    return { ok: true, reason: 'already_signed_in', token, deviceId, storage };
  }

  // 进登录表单
  if (!st.passwordForm) {
    const ok = await clickByTexts(page, LABELS.passwordLogin, { exact: true });
    log(ok ? '已切到密码登录' : '没找到「密码登录」入口，可能已经是密码表单');
    await page.waitForTimeout(rand(700, 1400));
  }
  await page.waitForSelector('input[type=password]', { timeout: 20_000 });

  // 等数美设备号就绪（device_id 为空会被服务端 422 直接拒）
  onProgress('wait-device');
  await page
    .waitForFunction(
      () => {
        const items = Object.keys(localStorage);
        return items.some((k) => k.startsWith('.thumbcache_')) && Boolean(localStorage.getItem('smidV2'));
      },
      { timeout: 25_000 },
    )
    .catch(() => log('数美指纹没在 25s 内就绪，仍然尝试提交'));

  const inputs = page.locator('input');
  await inputs.nth(0).click();
  await typeHuman(page, email);
  await inputs.nth(1).click();
  await typeHuman(page, password, { min: 55, max: 120 });
  await page.waitForTimeout(rand(600, 1200));
  check();

  // 提交：422（device_id 未就绪）时等一会儿重试，不做无脑连点
  let submitAttempts = 0;
  for (;;) {
    submitAttempts += 1;
    check();
    await clickByTexts(page, LABELS.login, { exact: true });
    await page.waitForTimeout(rand(2500, 4000));
    st = await pageState(page);
    if (st.signedIn || st.mfa || st.captcha || !st.signedOut) break;

    const body = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    const needsDevice = /device_id|请稍后|稍后再试/.test(body);
    log(`第 ${submitAttempts} 次提交未通过${needsDevice ? '（设备号未就绪）' : ''}`);
    if (submitAttempts >= 3) throw new Error('密码提交 3 次仍未通过（检查账号密码 / 设备指纹）');
    await page.waitForTimeout(rand(3000, 5000));
  }

  // 登录页的人机验证（有的地区在密码提交前就弹）
  if (st.captcha) {
    onProgress('captcha-login');
    const solved = await solveUntilGone(page, { log });
    if (!solved.ok) throw new Error(`登录页人机验证未通过：${solved.reason}`);
    await page.waitForTimeout(rand(1500, 2500));
    await clickByTexts(page, LABELS.login, { exact: true });
    await page.waitForTimeout(rand(3000, 4500));
    st = await pageState(page);
  }

  // MFA：邮箱验证码
  if (st.mfa) {
    onProgress('mfa');
    log('服务端要求邮箱验证码（biz_code 14）');
    if (!mailConfigured(mail)) throw new Error('需要邮箱验证码，但 MAIL_USER / MAIL_PASS 未配置');

    let sent = false;
    for (let i = 0; i < 3 && !sent; i += 1) {
      const since = Date.now();
      await clickByTexts(page, LABELS.sendCode, { exact: true });
      await page.waitForTimeout(rand(2000, 3000));

      // 发送动作本身可能挂数美点选
      if (await pageState(page).then((s) => s.captcha)) {
        onProgress('captcha-send');
        const solved = await solveUntilGone(page, { log });
        if (!solved.ok) {
          log(`「发送验证码」的人机验证没过：${solved.reason}`);
          await page.waitForTimeout(rand(2000, 3500));
          continue;
        }
        await page.waitForTimeout(rand(1500, 2500));
      }

      try {
        const { code } = await waitForCode({ cfg: mail, sinceMs: since, signal, log });
        log(`拿到邮箱验证码 ${code}`);
        const codeInput = page.locator('input').filter({ hasNot: page.locator('[type=password]') }).last();
        await codeInput.click();
        await typeHuman(page, code, { min: 90, max: 180 });
        await page.waitForTimeout(rand(400, 900));
        await clickByTexts(page, LABELS.verifyAndLogin, { exact: true });
        await page.waitForTimeout(rand(3500, 5000));
        sent = true;
      } catch (err) {
        log(`等码失败：${err.message}`);
      }
    }
    if (!sent) throw new Error('邮箱验证码流程失败');
    st = await pageState(page);
  }

  // 收尾：等进聊天页
  for (let i = 0; i < 12; i += 1) {
    st = await pageState(page);
    if (st.signedIn && st.hasTextarea) break;
    if (st.captcha) {
      const solved = await solveUntilGone(page, { log });
      if (!solved.ok) break;
    }
    await page.waitForTimeout(1500);
  }

  const { token, deviceId, storage } = await readToken(page);
  if (!token) throw new Error('登录流程结束但没有拿到 userToken（可能仍停在验证页）');
  log(`登录成功，token 长度 ${token.length}，设备 ${deviceId || '(未知)'}`);
  return { ok: true, token, deviceId, storage, url: page.url() };
}

/**
 * 登录产物落盘：只写 token 文件（data/auth.json）。
 *
 * 「真人档案」（整包 localStorage 落盘 + 启动时注入）这条链路已经砍掉，
 * 所以这里不再往 data/profiles/ 写任何东西——写了也没有消费方。
 */
export function persistLogin({ config, token, deviceId }) {
  const { dataDir } = config;
  fs.mkdirSync(dataDir, { recursive: true });

  const authFile = path.join(dataDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ token, deviceId, savedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });

  return { authFile };
}

/**
 * 注入「token 转发」脚本：页面里守着自己的 localStorage，
 * 一旦 token 变化（比如服务端轮换），立刻通知 Node 侧落盘。
 *
 * 这不是伪造任何东西，只是把我们自己的凭证读出来 —— 但放在页面上下文里做，
 * 就不需要每次登录后手动 `copy(localStorage)` 了。
 */
export async function installTokenBridge(page, onToken) {
  await page.exposeFunction('__opendsToken', (payload) => {
    try {
      onToken?.(payload);
    } catch {
      /* ignore */
    }
  });
  await page.addInitScript(() => {
    const push = () => {
      try {
        const raw = localStorage.getItem('userToken');
        if (!raw) return;
        let token = raw;
        try {
          const o = JSON.parse(raw);
          if (o && typeof o.value === 'string') token = o.value;
        } catch {
          /* 纯字符串 */
        }
        const did = localStorage.getItem('deepseek-device-id:chat') || null;
        if (token && token !== window.__opendsLastToken) {
          window.__opendsLastToken = token;
          window.__opendsToken?.({ token, deviceId: did, at: Date.now() });
        }
      } catch {
        /* ignore */
      }
    };
    push();
    setInterval(push, 5000);
    window.addEventListener('storage', push);
  });
}

export { humanClick, sleep };
