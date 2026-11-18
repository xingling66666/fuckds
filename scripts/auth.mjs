import { chromium } from 'playwright';

import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { loginWithBrowser, persistLogin, readToken } from '../src/browser/login.mjs';
import { buildLaunchEnv, resolveChromiumExecutable } from '../src/browser/env.mjs';

/**
 * 命令行登录：真浏览器 → 密码 → （必要时）数美点选 + 邮箱验证码 → 落盘 token。
 *
 * 用法：
 *   npm run auth                                  # 用 DS_EMAIL / DS_PASSWORD
 *   npm run auth -- --email a@b.com --password xx
 *   node scripts/auth.mjs --headed=false          # 无头（更容易被要求验证码）
 *
 * 需要的环境变量（读验证码用）：
 *   MAIL_USER=xxx@gmail.com
 *   MAIL_PASS=<Gmail 应用专用密码>
 */
function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i > 0 && process.argv[i + 1]) return process.argv[i + 1];
  const kv = process.argv.find((a) => a.startsWith(`--${name}=`));
  return kv ? kv.split('=').slice(1).join('=') : fallback;
}

const flagOf = (name, fallback = false) => {
  if (process.argv.includes(`--${name}`)) return true;
  if (process.argv.includes(`--no-${name}`)) return false;
  const kv = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (kv) return kv.split('=')[1] !== 'false';
  return fallback;
};

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel ?? 'info' });
  const email = argOf('email', config.login?.email || process.env.DS_EMAIL || '');
  const password = argOf('password', config.login?.password || process.env.DS_PASSWORD || '');
  const headless = flagOf('headed', true) === false;

  if (!email || !password) {
    console.error('缺少账号密码：设置 DS_EMAIL / DS_PASSWORD，或 --email / --password');
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless,
    executablePath: resolveChromiumExecutable(config),
    env: buildLaunchEnv(config, logger),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--no-first-run',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1512, height: 950 },
    locale: 'zh-CN',
    timezoneId: process.env.TZ || 'Asia/Shanghai',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  try {
    const out = await loginWithBrowser(page, {
      email,
      password,
      log: (m) => logger.info(`[login] ${m}`),
    });
    const { authFile } = persistLogin({ config, ...out });
    const again = await readToken(page);
    logger.info(`已保存 token 到 ${authFile}`);
    console.log(JSON.stringify({ ok: true, authFile, token: `${again.token?.slice(0, 10)}…`, deviceId: again.deviceId }, null, 2));
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`登录失败：${err.message}`);
  process.exit(1);
});
