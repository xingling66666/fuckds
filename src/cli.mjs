/**
 * 命令行参数 → 环境变量。
 *
 * 为什么是「翻译成环境变量」而不是另做一套：config.mjs 已经有一套完整的
 * ENV_SCHEMA（类型、默认值、写库迁移），命令行只是它的**前置覆盖层**。
 * 这样 `--port 8080` 和 `PORT=8080` 走的是同一条路径，行为完全一致，
 * 也不会出现「命令行只支持一半配置」的割裂。
 *
 * 用法（编译成二进制后同样有效）：
 *   freetoken --port 8080 --host 0.0.0.0 --data ./data --engine hybrid
 *   freetoken --set API_KEY=sk-xxx --set LOG_LEVEL=debug
 *   PORT=8080 freetoken                # 环境变量仍然可用
 *   freetoken --help
 */

import fs from 'node:fs';
import path from 'node:path';

/** 常用短参数 → 环境变量名 */
const ALIASES = {
  p: 'PORT',
  H: 'HOST',
  d: 'DATA_DIR',
  e: 'DS_ENGINE',
  k: 'API_KEY',
  c: 'CONCURRENCY',
  v: 'LOG_LEVEL',
};

/** 常用参数 → 环境变量名（长参数） */
const LONG = {
  port: 'PORT',
  host: 'HOST',
  data: 'DATA_DIR',
  'data-dir': 'DATA_DIR',
  engine: 'DS_ENGINE',
  'api-key': 'API_KEY',
  concurrency: 'CONCURRENCY',
  'log-level': 'LOG_LEVEL',
  proxy: 'DEEPSEEK_PROXIES',   // 真实 key 是复数，支持逗号分割多个
  timeout: 'REQUEST_TIMEOUT_MS',
  warmup: 'WARMUP',
};

const HELP = `
freetoken —— 把 DeepSeek 网页版包装成 OpenAI / Anthropic 兼容 API

用法：
  freetoken [选项]                     不带参数时读环境变量 / 数据库配置
  freetoken --port 8787 --host 127.0.0.1

常用选项：
  -p, --port <端口>          监听端口（等价 PORT）
  -H, --host <地址>          监听地址（等价 HOST，默认 127.0.0.1）
  -d, --data <目录>          数据目录（config.db / auth.json 放这里，等价 DATA_DIR）
  -e, --engine <模式>        hybrid | browser | direct（等价 DS_ENGINE）
  -k, --api-key <key>        接口鉴权 key（等价 API_KEY，留空表示不鉴权）
  -c, --concurrency <n>      并发数（等价 CONCURRENCY）
  -v, --log-level <level>    error|warn|info|debug|trace（等价 LOG_LEVEL）
      --proxy <url>          出站代理（等价 DEEPSEEK_PROXIES，支持 http:// / socks5://，逗号可写多个）
      --timeout <毫秒>        单次请求超时（等价 REQUEST_TIMEOUT_MS）
      --set KEY=VALUE        任意配置项，可重复（KEY 就是后台设置里的名字）
      --data-dir-init        仅创建数据目录后退出（容器初始化用）

其它：
  -h, --help                 显示本帮助
  -V, --version              显示版本

优先级（后者覆盖前者）：
  数据库里的设置  <  环境变量  <  命令行参数
`.trim();

/** 只创建数据目录（容器 entrypoint 常用） */
function ensureDataDir(dir) {
  const target = path.resolve(dir || './data');
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function parseCliArgs(argv = process.argv.slice(2), env = process.env) {
  const applied = {};
  const unknown = [];
  let help = false;
  let version = false;
  let initOnly = false;
  let dataDir = '';

  const setEnv = (key, value) => {
    if (!key) return;
    const name = String(key).trim().toUpperCase();
    env[name] = String(value);
    applied[name] = String(value);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];

    if (raw === '-h' || raw === '--help') {
      help = true;
      continue;
    }
    if (raw === '-V' || raw === '--version') {
      version = true;
      continue;
    }
    if (raw === '--data-dir-init') {
      initOnly = true;
      continue;
    }

    // --key=value
    if (raw.startsWith('--') && raw.includes('=')) {
      const [flag, ...rest] = raw.slice(2).split('=');
      const value = rest.join('=');
      if (flag === 'set') {
        const [k, ...v] = value.split('=');
        setEnv(k, v.join('='));
      } else if (LONG[flag]) {
        setEnv(LONG[flag], value);
        if (LONG[flag] === 'DATA_DIR') dataDir = value;
      } else {
        // 未知长参数但形如 --FOO=bar，也当配置项（便于透传新配置）
        setEnv(flag, value);
      }
      continue;
    }

    // --set KEY=VALUE
    if (raw === '--set') {
      const pair = argv[++i] ?? '';
      const [k, ...v] = pair.split('=');
      setEnv(k, v.join('='));
      continue;
    }

    // -k value / --port value / -abc（短参数聚合不支持，只支持单个）
    if (raw.startsWith('-')) {
      const flag = raw.replace(/^--?/, '');
      const key = flag.length === 1 ? ALIASES[flag] : LONG[flag];
      const value = argv[++i];
      if (value === undefined) {
        unknown.push(raw);
        continue;
      }
      if (key) {
        setEnv(key, value);
        if (key === 'DATA_DIR') dataDir = value;
      } else {
        setEnv(flag, value);
      }
      continue;
    }

    unknown.push(raw);
  }

  return { applied, unknown, help, version, initOnly, dataDir };
}

export function printHelp(log = console.log) {
  log(HELP);
}

export function applyCliArgs({ argv = process.argv.slice(2), env = process.env, log = console.log } = {}) {
  const parsed = parseCliArgs(argv, env);

  if (parsed.help) {
    printHelp(log);
    return { ...parsed, exit: true };
  }
  if (parsed.version) {
    log(`freetoken ${env.npm_package_version || '2.x'} (compiled: ${process.versions.bun ? 'bun' : 'node'})`);
    return { ...parsed, exit: true };
  }
  if (parsed.initOnly) {
    const dir = ensureDataDir(parsed.dataDir || env.DATA_DIR);
    log(`数据目录已就绪：${dir}`);
    return { ...parsed, exit: true };
  }
  if (parsed.unknown.length) {
    log(`⚠️ 忽略了无法识别的参数：${parsed.unknown.join(' ')}（用 --help 看用法）`);
  }

  return { ...parsed, exit: false };
}

export { HELP };
