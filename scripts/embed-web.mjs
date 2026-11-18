#!/usr/bin/env node
/**
 * 把 web/dist 内联成 JS 模块，供 `bun build --compile` 打进二进制。
 *
 * 为什么需要：单文件二进制里没有磁盘上的 web/dist，后台页面会 404。
 * Bun 的 `--compile` 只嵌入**被 import 到的**模块，所以这里把每个静态文件
 * 转成 base64 常量塞进一个生成模块，再由 serveStatic 优先从内存里取。
 *
 * 用法：node scripts/embed-web.mjs   （build:all 里会自动跑）
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'web', 'dist');
const OUT = path.join(ROOT, 'src', 'admin', 'web-assets.generated.mjs');
const POW_SRC = path.join(ROOT, 'bin', 'ds-pow');
const POW_OUT = path.join(ROOT, 'src', 'direct', 'pow-asset.generated.mjs');

if (!fs.existsSync(DIST)) {
  console.error(`[embed-web] 找不到 ${DIST}，请先 npm --prefix web run build`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
};

function walk(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

const files = walk(DIST);
const entries = [];
let rawBytes = 0;

for (const { rel, full } of files) {
  const buf = fs.readFileSync(full);
  rawBytes += buf.length;
  const ext = path.extname(rel).toLowerCase();
  entries.push({
    rel: rel.replace(/\\/g, '/'),
    type: MIME[ext] || 'application/octet-stream',
    b64: buf.toString('base64'),
  });
}

const body = entries
  .map(
    (e) =>
      `  ${JSON.stringify(e.rel)}: { type: ${JSON.stringify(e.type)}, b64: ${JSON.stringify(e.b64)} },`,
  )
  .join('\n');

const module = `/**
 * 由 scripts/embed-web.mjs 自动生成 —— 不要手改。
 * 内容：web/dist 的全部静态文件（base64），用于单文件二进制里托管后台。
 * 生成时间：${new Date().toISOString()}
 * 文件数：${entries.length}，原始大小：${rawBytes} 字节
 */

export const WEB_ASSETS = {
${body}
};

/** 取一个资源：返回 { buffer, type } 或 null */
export function getWebAsset(relPath) {
  const key = String(relPath || '').replace(/^\\/+/, '').replace(/\\\\/g, '/');
  const hit = WEB_ASSETS[key];
  if (!hit) return null;
  return { buffer: Buffer.from(hit.b64, 'base64'), type: hit.type };
}

export const WEB_ASSET_COUNT = ${entries.length};
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, module);
console.log(
  `[embed-web] 已生成 ${path.relative(ROOT, OUT)}：${entries.length} 个文件，` +
    `${(rawBytes / 1024).toFixed(0)}KB → base64 ${(Buffer.byteLength(module) / 1024 / 1024).toFixed(2)}MB`,
);


/* ------------------------------------------------------------------ *
 * 顺带内联 PoW 求解器（bin/ds-pow，Go 编译的二进制）
 *
 * 单文件发布时磁盘上不会有 bin/ds-pow，运行时按需解包到临时目录再 chmod +x。
 * 用内容 sha256 做文件名，多个进程共用同一份，不会重复写。
 * ------------------------------------------------------------------ */
if (fs.existsSync(POW_SRC)) {
  const buf = fs.readFileSync(POW_SRC);
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(buf).digest('hex');
  const module = `/**
 * 由 scripts/embed-web.mjs 自动生成 —— 不要手改。
 * 内容：bin/ds-pow（PoW 求解器二进制，${buf.length} 字节）
 * sha256：${sha}
 */

export const POW_ASSET = {
  sha256: ${JSON.stringify(sha)},
  size: ${buf.length},
  b64: ${JSON.stringify(buf.toString('base64'))},
};
`;
  fs.mkdirSync(path.dirname(POW_OUT), { recursive: true });
  fs.writeFileSync(POW_OUT, module);
  console.log(`[embed-web] 已内联 PoW 求解器：${(buf.length / 1024 / 1024).toFixed(1)}MB（sha256 ${sha.slice(0, 12)}）`);
} else {
  fs.mkdirSync(path.dirname(POW_OUT), { recursive: true });
  fs.writeFileSync(POW_OUT, 'export const POW_ASSET = null;\n');
  console.log('[embed-web] 没有 bin/ds-pow，写入占位模块（运行时会找磁盘路径）');
}
