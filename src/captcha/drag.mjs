import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * hCaptcha「拖动滑块完成拼图」的自动过法 —— 纯 CV，不依赖任何打码平台。
 *
 * 分工：
 *   - 截图、拖动           → Playwright（这里）
 *   - 计算拼图块的目标偏移 → tools/captcha/cv.py（numpy + Pillow，已装）
 *
 * 为什么拆开：图像匹配用 numpy 写最省事也最快（300×200 全图滑动 < 100ms），
 * 而拖拽需要真人曲线（先快后慢 + 抖动），只有 Playwright 能做像。
 */

const CV = path.resolve(process.cwd(), 'tools/captcha/cv.py');
const SAMPLE_DIR = path.resolve(process.cwd(), 'data/captcha-samples');

/** 调 python 算偏移 */
export async function computeOffset(bgPath, piecePath) {
  const { stdout } = await run('python3', [CV, 'drag-offset', '--bg', bgPath, '--piece', piecePath], {
    timeout: 30_000,
  });
  return JSON.parse(stdout.trim());
}

/**
 * 找到 hCaptcha 里的拖拽题面并截图。
 * 返回 { bgPath, piecePath, box }；拿不到返回 null。
 */
export async function captureDragChallenge(frame, tag = 'drag') {
  fs.mkdirSync(SAMPLE_DIR, { recursive: true });
  const stamp = `${tag}-${Date.now()}`;

  // 题面通常在 iframe 里的 .challenge-container / canvas 区域
  const candidates = [
    frame.locator('.challenge-container'),
    frame.locator('div[class*="challenge"]').first(),
    frame.locator('canvas').first(),
  ];
  let box = null;
  for (const loc of candidates) {
    if (await loc.count().catch(() => 0)) {
      const b = await loc.boundingBox().catch(() => null);
      if (b && b.width > 120 && b.height > 80) {
        box = b;
        break;
      }
    }
  }
  if (!box) return null;

  const fullPath = path.join(SAMPLE_DIR, `${stamp}-full.png`);
  await frame.page().screenshot({ path: fullPath, clip: box }).catch(() => {});

  // 拼图块一般是画布左侧那块带边框的小图；先整图截下来，切图交给 python
  return { fullPath, box, stamp };
}

/**
 * 从整图里切出「背景」和「拼图块」。
 *
 * hCaptcha 的拖拽题面布局：背景 300×200，拼图块贴在左侧的起始位置（通常垂直居中偏上），
 * 走到正确位置后与背景挖空处重合。这里用固定比例切初始块，再让 CV 去背景里找它。
 */
export async function splitDragImages(fullPath, outDir = '/tmp') {
  const { stdout } = await run(
    'python3',
    [
      '-c',
      `
import sys, json
from PIL import Image
img = Image.open(${JSON.stringify(fullPath)}).convert('RGB')
W, H = img.size
# 背景占满整个画布；拼图块的初始位置固定在左侧，尺寸约 1/5 宽
pw = max(24, W // 6)
ph = pw
# 从左边缘起的这一块当作拼图块（hCaptcha 的块起始位置在画布左边界）
piece = img.crop((0, (H - ph) // 2, pw, (H - ph) // 2 + ph))
piece_path = ${JSON.stringify(outDir)} + '/piece.png'
piece.save(piece_path)
print(json.dumps({'piece': piece_path, 'piece_w': pw, 'piece_h': ph, 'w': W, 'h': H}))
      `,
    ],
    { timeout: 20_000 },
  );
  return JSON.parse(stdout.trim());
}

/** 真人曲线拖动：先快后慢 + 轻微抖动 + 到位微调 */
export async function humanDrag(page, from, to, { steps = 26 } = {}) {
  const dx = to.x - from.x;
  const dy = (to.y ?? from.y) - from.y;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  let prev = { x: from.x, y: from.y };
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    // easeOutQuad：起步快，收尾慢，接近人手
    const eased = 1 - (1 - t) * (1 - t);
    const x = from.x + dx * eased + (Math.random() - 0.5) * 1.6;
    const y = from.y + dy * eased + (Math.random() - 0.5) * 1.2;
    await page.mouse.move(x, y, { steps: 1 });
    prev = { x, y };
    await page.waitForTimeout(9 + Math.random() * 12);
  }
  // 到位后小幅回拉，模拟人对齐
  await page.mouse.move(prev.x - 1.5, prev.y, { steps: 2 });
  await page.waitForTimeout(60 + Math.random() * 60);
  await page.mouse.up();
}

/**
 * 一把过：截图 → 切块 → CV 定位 → 真人曲线拖动。
 * @returns {{ok:boolean, offset?:object, reason?:string}}
 */
export async function solveDragCaptcha(frame, logger = console) {
  const cap = await captureDragChallenge(frame);
  if (!cap) return { ok: false, reason: '没找到拖拽题面元素' };

  const split = await splitDragImages(cap.fullPath);
  const offset = await computeOffset(cap.fullPath, split.piece);
  logger.info?.(`拖拽题：块 ${split.piece_w}px，定位 (${offset.x}, ${offset.y}) score=${offset.score}`);

  // 找滑块手柄
  const handle = frame.locator('.slider, [class*="slider"], [class*="handle"]').first();
  const hb = await handle.boundingBox().catch(() => null);
  if (!hb) return { ok: false, reason: '没找到滑块手柄' };

  const from = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 };
  const to = { x: from.x + offset.x, y: from.y };
  await humanDrag(frame.page(), from, to);
  return { ok: true, offset };
}
