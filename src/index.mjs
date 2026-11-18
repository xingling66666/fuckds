import { applyCliArgs } from './cli.mjs';

// 命令行 → 环境变量（必须在 loadConfig 之前执行；二进制自带的 --help/--version 也在这里处理）
const cli = applyCliArgs();
if (cli.exit) process.exit(0);

import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createEngine } from './engine.mjs';
import { createServer } from './server.mjs';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const web = createEngine({ config, logger });
const server = createServer({ config, logger, web });

const shutdown = async (signal) => {
  logger.info(`收到 ${signal}，正在关闭…`);
  server.close();
  await web.close().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝:', err));

if (config.runtime.warmup) {
  // hybrid / direct 模式预热的是直连侧（PoW 挑战 + 会话），不会拉起浏览器
  web.warmUp()
    .then(() => logger.info('引擎已预热（转发走直连接口，浏览器只在登录时启动）'))
    .catch((err) => logger.warn('预热失败（首次请求会自动重试）:', err.message));
}

server.listen(config.server.port, config.server.host, () => {
  const base = `http://${config.server.host}:${config.server.port}`;
  logger.info('服务已启动');
  logger.info(`  接口       ${base}/v1/chat/completions`);
  logger.info(`  模型列表   ${base}/v1/models`);
  logger.info(`  健康检查   ${base}/healthz`);
  logger.info(
    `  登录态     ${
      config.deepseek.tokens.length
        ? `已配置 ✅ 号池 ${config.deepseek.tokens.length} 个`
        : '未配置 ❌（npm run auth -- <userToken>）'
    }`,
  );
  logger.info(`  引擎       ${web.status().engine || 'hybrid'}`);
  logger.info(`  并发       ${config.runtime.concurrency}，单次超时 ${Math.round(config.runtime.requestTimeoutMs / 1000)}s`);
});

server.on('error', (err) => {
  logger.error('HTTP 服务启动失败:', err.message);
  process.exit(1);
});
