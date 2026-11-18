/**
 * Playwright 懒加载入口。
 *
 * 为什么不用顶层静态 import：
 *   `bun build --compile` 打包 playwright 时，它内部有一处**动态拼出来的**
 *   `require('playwright-core/package.json')`，bun 无法内联，运行期会回源码路径找
 *   （单文件部署直接启动失败：Cannot find module '/build/.../node_modules/playwright-core/package.json'）。
 *
 * 所以这里：
 *   1. 编译时用 `--external playwright`，把它当外部依赖；
 *   2. 运行时按需 import（装在 <安装目录>/node_modules 或 NODE_PATH 里就能找到）；
 *   3. **加载失败也不影响核心转发** —— 只有「自动登录 / 注册 / 代理测试」这些
 *      需要真浏览器的功能会报一句人话错误。
 */

let cached = null;
let failure = null;

export function playwrightAvailable() {
  return Boolean(cached) || (failure === null && false);
}

/** @returns {Promise<{chromium: any, firefox?: any, webkit?: any}>} */
export async function loadPlaywright() {
  if (cached) return cached;
  if (failure) throw failure;

  try {
    cached = await import('playwright');
    return cached;
  } catch (err) {
    try {
      // 只装了核心包（不带浏览器下载脚本）时也能用，前提是自己提供 executablePath
      cached = await import('playwright-core');
      return cached;
    } catch {
      failure = new Error(
        '需要 playwright 才能启动浏览器（自动登录 / 注册 / 代理测试）。' +
          '请在安装目录执行 `npm i playwright` 或把 playwright-core 放到 node_modules 下；' +
          '纯 API 转发不需要它。',
      );
      throw failure;
    }
  }
}

/** 供后台展示：浏览器能力是否可用（不触发加载） */
export function playwrightState() {
  if (cached) return { available: true, reason: '' };
  if (failure) return { available: false, reason: failure.message };
  return { available: null, reason: '未加载' };
}

export default { loadPlaywright, playwrightAvailable, playwrightState };
