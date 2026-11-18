import assert from 'node:assert/strict';
import test from 'node:test';

import { DeepSeekWeb, desktopUserAgent } from '../src/browser/driver.mjs';
import { createLogger } from '../src/logger.mjs';
import { makeConfig } from './helpers/config.mjs';

/**
 * 这两组断言锁的都是「后台能不能如实看到号池 / 浏览器会不会说中文」这类
 * 之前被静默漏掉的问题，不需要真浏览器就能跑。
 */

const logger = createLogger('error');

test('驱动：status() 如实报告运行时号池（后台概览的 accounts 数据源）', () => {
  const config = makeConfig({ DEEPSEEK_USER_TOKEN: 'tok-aaaaaaaaaaaaaa' });
  const web = new DeepSeekWeb({ config, logger });
  const status = web.status();

  assert.equal(Array.isArray(status.accounts), true, 'status() 必须带 accounts 数组');
  assert.equal(status.accounts.length, 1);
  const [account] = status.accounts;
  assert.equal(account.index, 1);
  // 未用过的号给合理默认值
  assert.equal(account.requests, 0);
  assert.equal(account.cooldownMs, 0);
  assert.equal(account.lastError, null);
  assert.equal(account.available, true);
  assert.equal(account.authFailed, false);
  // token 必须打码：概览页是明文展示区
  assert.ok(!account.token.includes('tok-aaaaaaaaaaaaaa'), `token 未打码: ${account.token}`);
  assert.ok(account.token.includes('…'));
});

test('驱动：多 token 时逐条返回，主 token 排第一，index 从 1 开始', () => {
  const config = makeConfig({ DEEPSEEK_USER_TOKEN: 'tok-aaaaaaaaaaaaaa' });
  config.deepseek.tokens = ['tok-aaaaaaaaaaaaaa', 'tok-bbbbbbbbbbbbbb'];
  config.deepseek.token = 'tok-bbbbbbbbbbbbbb';
  const web = new DeepSeekWeb({ config, logger });

  const { accounts } = web.status();
  assert.deepEqual(
    accounts.map((a) => a.index),
    [1, 2],
  );
  assert.ok(accounts[0].token.includes('tok-bb'), '主 token 必须排在第一位');
  assert.ok(accounts.every((a) => !a.token.includes('tok-aaaaaaaaaaaaaa') && !a.token.includes('tok-bbbbbbbbbbbbbb')));
});

test('驱动：调用统计会体现在号池状态里', () => {
  const config = makeConfig({ DEEPSEEK_USER_TOKEN: 'tok-cccccccccccccc' });
  const web = new DeepSeekWeb({ config, logger });
  web.tokenStats.requests = 3;
  web.cooldownUntil = Date.now() + 5000;
  const [account] = web.status().accounts;
  assert.equal(account.requests, 3);
  assert.ok(account.cooldownMs > 0 && account.cooldownMs <= 5000);
});

test('配置：浏览器 locale 默认 zh-CN，viewport / UA 可用环境变量覆盖', () => {
  const def = makeConfig();
  assert.equal(def.browser.locale, 'zh-CN');
  assert.deepEqual(def.browser.viewport, { width: 1440, height: 900 });
  // 空 = 启动时按实际 Chromium 版本自动生成
  assert.equal(def.browser.userAgent, '');

  const custom = makeConfig({
    BROWSER_LOCALE: 'en-US',
    BROWSER_VIEWPORT: '1280x800',
    BROWSER_USER_AGENT: 'UA-FROM-ENV',
  });
  assert.equal(custom.browser.locale, 'en-US');
  assert.deepEqual(custom.browser.viewport, { width: 1280, height: 800 });
  assert.equal(custom.browser.userAgent, 'UA-FROM-ENV');

  // 兼容老的 BROWSER_WIDTH / BROWSER_HEIGHT 写法
  const legacy = makeConfig({ BROWSER_WIDTH: '1512', BROWSER_HEIGHT: '950' });
  assert.deepEqual(legacy.browser.viewport, { width: 1512, height: 950 });

  // 非法 viewport 回退默认值，别把 Playwright 塞进非法尺寸
  const broken = makeConfig({ BROWSER_VIEWPORT: 'huge' });
  assert.deepEqual(broken.browser.viewport, { width: 1440, height: 900 });
});

test('配置：自动生成的桌面 UA 跟随实际 Chromium 版本且不带 Headless 标记', () => {
  const ua = desktopUserAgent('156.0.8078.4');
  assert.ok(ua.includes('Chrome/156.0.0.0'), ua);
  assert.ok(ua.includes('Safari/537.36'), ua);
  assert.ok(!/Headless/i.test(ua), ua);
  // 版本缺失时也要给出一个可用的 UA，不能是 undefined
  assert.ok(/Chrome\/\d+\.0\.0\.0/.test(desktopUserAgent()));
});
