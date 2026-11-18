#!/usr/bin/env node
/**
 * 号池体检（浏览器版）。
 *
 * 只做两件事：
 *   1. 列出号池里的 token（掩码）+ 设备 + 被吊销次数（本地记账）
 *   2. --probe 时打开真浏览器看一眼登录态还在不在（唯一的判据，纯协议探活会误报）
 *
 * 用法：
 *   npm run doctor
 *   npm run doctor -- --probe
 *
 * 为什么不用「发一个请求看返回码」来探活：真请求会进入风控链路，
 * 探一次就等于消耗一次风险分；而打开页面看是否被踢回 /sign_in 是零副作用的。
 */
import { loadConfig } from '../src/config.mjs';
import { loadTokenRecords, maskToken } from '../src/auth.mjs';
import { getTokenMeta } from '../src/token-meta.mjs';
import { createEngine } from '../src/engine.mjs';
import { createLogger } from '../src/logger.mjs';

const probe = process.argv.includes('--probe');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel ?? 'info' });
  const records = loadTokenRecords(config);

  if (!records.length) {
    console.log('号池是空的。先跑 `npm run auth` 登录，或在后台点「自动登录」。');
    return;
  }

  const rows = records.map((row, i) => {
    const meta = getTokenMeta(config.dataDir, row.token);
    return {
      index: i + 1,
      token: maskToken(row.token),
      deviceId: row.deviceId || null,
      source: row.source || meta.source || 'unknown',
      revokedCount: meta.revokedCount || 0,
    };
  });
  console.table(rows);

  if (!probe) {
    console.log('加 --probe 打开浏览器实测登录态（零副作用，不消耗风险分）');
    return;
  }

  const engine = createEngine({ config, logger });
  try {
    const health = await engine.probe();
    console.log(health.alive ? '✅ 登录态有效' : `❌ 登录态失效：${health.msg}`);
    if (!health.alive) console.log('   处理：跑 `npm run auth` 重新自动登录');
  } finally {
    await engine.close?.().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`体检失败：${err.message}`);
  process.exit(1);
});
