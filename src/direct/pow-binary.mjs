/**
 * PoW 求解器定位：磁盘优先，没有就用编译进二进制的内联副本。
 *
 * 单文件发布时 bin/ds-pow 不在磁盘上，这里把它解包到临时目录（按内容 sha256 命名）
 * 并 chmod +x。多进程/多实例命中同一个 hash 就复用同一份，不会反复写盘。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 静态引入：动态 import 在 `bun build --compile` 里不保证被打进二进制
import { POW_ASSET } from './pow-asset.generated.mjs';

let cached = null;

function isExecutableFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} [configured] 配置里的路径（默认 <root>/bin/ds-pow）
 * @returns {string|null} 可直接 spawn 的 PoW 求解器路径
 */
export function resolvePowBin(configured = '') {
  if (cached) return cached;

  // 1) 磁盘上有就用磁盘上的（允许用户替换成新版本 / 自己编译）
  if (configured && isExecutableFile(configured)) {
    cached = configured;
    return cached;
  }

  // 2) 内联副本：按内容 hash 解包到临时目录
  try {
    if (!POW_ASSET?.b64) return null;
    const dir = path.join(os.tmpdir(), 'freetoken-pow');
    const target = path.join(dir, `ds-pow-${String(POW_ASSET.sha256).slice(0, 16)}`);
    if (!isExecutableFile(target)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, Buffer.from(POW_ASSET.b64, 'base64'), { mode: 0o755 });
      fs.chmodSync(target, 0o755);
    }
    cached = target;
    return cached;
  } catch {
    return null;
  }
}

export function resetPowBinCache() {
  cached = null;
}

export function powAssetInfo() {
  return POW_ASSET ? { sha256: POW_ASSET.sha256, size: POW_ASSET.size } : null;
}
