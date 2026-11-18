#!/usr/bin/env node
/**
 * 管理 DeepSeek 网页登录态（userToken），支持号池。
 *
 * 用法：
 *   npm run auth -- <token1> [token2 ...]   # 追加/覆盖为这些 token
 *   npm run auth                            # 交互式粘贴一个
 *   npm run auth -- --list                  # 查看号池
 *   npm run auth -- --check                 # 校验第一个 token
 *
 * userToken 位置：浏览器 F12 → Application → Local Storage →
 * https://chat.deepseek.com → userToken → 复制 value 字段。
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { loadTokens, maskToken, normalizeUserToken, saveTokens } from '../src/auth.mjs';
import { createEngine } from '../src/engine.mjs';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const listOnly = args.includes('--list');
const rawArgs = args.filter((a) => !a.startsWith('--'));

const config = loadConfig();
const logger = createLogger('info', 'auth');

if (listOnly) {
  const tokens = loadTokens(config);
  if (!tokens.length) {
    console.log('号池是空的，先执行 npm run auth -- <userToken>');
    process.exit(1);
  }
  console.log(`号池：${tokens.length} 个 token（${config.authFile}）`);
  tokens.forEach((token, i) => console.log(`  #${i + 1}  ${maskToken(token)}`));
  process.exit(0);
}

let tokens = loadTokens(config);

if (!checkOnly) {
  let candidates = rawArgs.length ? rawArgs : [];
  if (!candidates.length) {
    const rl = readline.createInterface({ input, output });
    console.log('');
    console.log('请粘贴 userToken（多个用空格/逗号分隔）：');
    const answer = (await rl.question('> ')).trim();
    rl.close();
    candidates = answer.split(/[\s,;]+/).filter(Boolean);
  }
  if (!candidates.length) {
    console.error('没有拿到 token，已退出');
    process.exit(1);
  }
  const normalized = candidates.map((t) => normalizeUserToken(t));
  const merged = args.includes('--replace') ? normalized : [...new Set([...tokens, ...normalized])];
  saveTokens(config, merged);
  tokens = merged;
  logger.info(`号池已保存 ${tokens.length} 个 token：${tokens.map(maskToken).join(' | ')}`);
}

if (!tokens.length) {
  console.error('没有可用的 token：请执行 npm run auth -- <userToken>');
  process.exit(1);
}

logger.info(`校验第 1 个 token（${maskToken(tokens[0])}）…`);

let engine;
let exitCode = 0;
try {
  // 用当前配置的引擎校验（默认 browser：真实打开网页看登录态；direct：调一次补全）
  engine = createEngine({
    config: { ...config, deepseek: { ...config.deepseek, tokens, token: tokens[0] } },
    logger,
  });
  if (typeof engine.checkLogin === 'function') {
    const login = await engine.checkLogin();
    if (login.ok) {
      logger.info(`✅ 登录态有效（已进入对话页：${login.url || 'chat.deepseek.com'}）`);
    } else if (login.captcha) {
      logger.error('❌ 打开页面时遇到人机验证，请先在浏览器里手动通过 / 换网络后重试');
      exitCode = 1;
    } else {
      logger.error('❌ token 无效或已过期：打开网页后没有进入对话页');
      exitCode = 1;
    }
  } else {
    const result = await engine.chat({
      prompt: '# MESSAGES:\n## USER_ROLE_MESSAGES:\n只回复：ok',
      thinking: false,
    });
    logger.info(`✅ 登录态有效（返回：${JSON.stringify(result.text.slice(0, 20))}）`);
  }
} catch (err) {
  if (err.code === 'deepseek_rate_limited') {
    logger.warn('⚠️ 账号当前被限流，token 本身可能是好的，稍后再试');
    exitCode = 0;
  } else if (err.name === 'AuthExpiredError') {
    logger.error('❌ token 无效或已过期');
    exitCode = 1;
  } else {
    logger.error('❌ 校验失败:', err.message);
    exitCode = 1;
  }
} finally {
  await engine?.close().catch(() => {});
}

process.exit(exitCode);
