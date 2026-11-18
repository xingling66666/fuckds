#!/usr/bin/env node
/**
 * 浏览器指纹采集（用于和「能注册成功的真机」做 diff）
 *
 *   node scripts/fp-dump.mjs [proxy]           # 在自动化浏览器里采
 *   node scripts/fp-dump.mjs --page            # 只打印可粘到 DevTools 的采集代码
 *
 * 输出 JSON；重点看 cdp* 和 webgl/canvas/uaData 几组。
 */
import { chromium } from 'playwright';

const COLLECT = `(async () => {
  const out = {};
  const nav = navigator;
  out.basic = {
    userAgent: nav.userAgent,
    appVersion: nav.appVersion,
    webdriver: nav.webdriver,
    platform: nav.platform,
    productSub: nav.productSub,
    vendor: nav.vendor,
    languages: nav.languages,
    language: nav.language,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    maxTouchPoints: nav.maxTouchPoints,
    pdfViewerEnabled: nav.pdfViewerEnabled,
    cookieEnabled: nav.cookieEnabled,
    doNotTrack: nav.doNotTrack,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
  };
  out.screen = {
    w: screen.width, h: screen.height,
    availW: screen.availWidth, availH: screen.availHeight,
    colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
    innerW: innerWidth, innerH: innerHeight,
    outerW: outerWidth, outerH: outerHeight,
    dpr: devicePixelRatio,
  };
  out.window = {
    hasChrome: typeof window.chrome,
    chromeKeys: window.chrome ? Object.keys(window.chrome) : null,
    chromeRuntime: typeof window.chrome?.runtime,
    chromeApp: typeof window.chrome?.app,
    chromeCsi: typeof window.chrome?.csi,
    chromeLoadTimes: typeof window.chrome?.loadTimes,
    plugins: [...(nav.plugins || [])].map(p => p.name).slice(0, 10),
    mimeTypes: nav.mimeTypes ? nav.mimeTypes.length : null,
  };
  try {
    if (nav.userAgentData) {
      out.uaData = {
        brands: nav.userAgentData.brands,
        mobile: nav.userAgentData.mobile,
        platform: nav.userAgentData.platform,
        high: await nav.userAgentData.getHighEntropyValues([
          'architecture','bitness','brands','formFactors','fullVersionList','model','platformVersion','uaFullVersion','wow64',
        ]),
      };
    }
  } catch (e) { out.uaData = { err: String(e) }; }

  // WebGL
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    const g2 = c.getContext('webgl2');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = {
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        version: gl.getParameter(gl.VERSION),
        shadingLang: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        webgl2: !!g2,
      };
    } else out.webgl = { none: true };
  } catch (e) { out.webgl = { err: String(e) }; }

  // Canvas 指纹
  try {
    const c = document.createElement('canvas'); c.width = 280; c.height = 60;
    const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '14px Arial'; x.fillStyle = '#f60';
    x.fillRect(100, 1, 62, 20); x.fillStyle = '#069';
    x.fillText('Cwm fjordbank \u{1F600} 中文', 2, 15);
    x.fillStyle = 'rgba(102,204,0,0.7)'; x.fillText('Cwm fjordbank \u{1F600} 中文', 4, 17);
    const data = c.toDataURL();
    let h = 0; for (let i = 0; i < data.length; i++) { h = (h * 31 + data.charCodeAt(i)) | 0; }
    out.canvas = { hash: h, len: data.length };
  } catch (e) { out.canvas = { err: String(e) }; }

  // Audio 指纹
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const d = buf.getChannelData(0);
    let sum = 0; for (let i = 0; i < d.length; i++) sum += Math.abs(d[i]);
    out.audio = { sum: +sum.toFixed(6) };
  } catch (e) { out.audio = { err: String(e) }; }

  // 权限 / 特征
  try {
    const q = async (n) => { try { return (await navigator.permissions.query({ name: n })).state; } catch { return 'n/a'; } };
    out.perms = { notifications: await q('notifications'), geolocation: await q('geolocation') };
  } catch (e) { out.perms = { err: String(e) }; }

  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    out.media = devs.map(d => d.kind).reduce((a, k) => (a[k] = (a[k] || 0) + 1, a), {});
  } catch (e) { out.media = { err: String(e) }; }

  // 字体探测（几个常见族）
  try {
    const probe = ['Arial','Courier New','Georgia','Times New Roman','Verdana','Tahoma','Segoe UI','Microsoft YaHei','SimSun','PingFang SC','Noto Sans CJK SC','DejaVu Sans','Liberation Sans'];
    const c = document.createElement('canvas'); const x = c.getContext('2d');
    const w = (f) => { x.font = '72px ' + f + ', monospace'; return x.measureText('mmmmmmmmmmlli').width; };
    const base = w('monospace');
    out.fonts = probe.filter(f => Math.abs(w(f) - base) > 0.01);
  } catch (e) { out.fonts = { err: String(e) }; }

  // ---- CDP / 自动化痕迹 ----
  out.cdp = {};
  // 1) webdriver 之外的典型痕迹：debugger 语句被 CDP 拦截时的耗时差异
  try {
    const t0 = performance.now();
    // eslint-disable-next-line no-debugger
    debugger;
    out.cdp.debuggerDeltaMs = +(performance.now() - t0).toFixed(3);
  } catch {}
  // 2) Function.prototype.toString 是否被替换
  try {
    out.cdp.fnToStringNative = /native code/.test(Function.prototype.toString.call(Function.prototype.toString));
  } catch {}
  // 3) 是否残留 Playwright/Puppeteer 注入的全局
  try {
    const keys = Object.keys(window).filter(k => /playwright|puppeteer|__pw|cdc_|__driver|webdriver|_selenium/i.test(k));
    out.cdp.globalLeaks = keys;
  } catch {}
  // 4) Error.stack 里的引擎路径
  try {
    const e = new Error('x');
    out.cdp.stackHead = String(e.stack).split('\\n').slice(0, 3);
  } catch {}
  // 5) 属性描述符异常（注入常留下 getter）
  try {
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    out.cdp.webdriverDesc = d ? { get: !!d.get, set: !!d.set, enumerable: d.enumerable, configurable: d.configurable } : null;
  } catch {}
  // 6) 权限 API 一致性（自动化常返回 notifications=denied）
  try {
    const n = Notification.permission; out.cdp.notificationPermission = n;
  } catch (e) { out.cdp.notificationPermission = 'ERR'; }

  return out;
})()`;

if (process.argv.includes('--page')) {
  console.log('// 粘到目标站页面的 DevTools Console，复制输出 JSON 贴回来：');
  console.log('copy(JSON.stringify(await ' + COLLECT + ', null, 1))');
  process.exit(0);
}

const PROXY = process.argv[2] || process.env.CLASH || 'http://127.0.0.1:7890';
const exe = process.env.DS_CHROME || '/usr/bin/chromium';
const b = await chromium.launch({
  headless: false,
  executablePath: exe,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US'],
  proxy: { server: PROXY },
  env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
});
const ctx = await b.newContext({
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
});
const pg = await ctx.newPage();
await pg.goto('https://chat.deepseek.com/sign_up', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
await pg.waitForTimeout(5000);
const fp = await pg.evaluate(COLLECT);
console.log(JSON.stringify(fp, null, 1));
await b.close();
process.exit(0);
