import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * 数美点选验证码（select / spatial_select）—— 识别靠 OpenCV，点击靠 CDP 真鼠标。
 *
 * 题面会以文本形式出现在面板下方，例如：
 *   「点击图中最小的绿色三棱柱」「点击图中最大的蓝色圆柱」
 *
 * 分工：
 *   - 识别：tools/captcha/shumei_select.py（HSV 分割 + 形状/颜色/面积排序）
 *   - 截图：Playwright clip，**1:1 不缩放**（缩放会把 offset 算错）
 *   - 点击：page.mouse（CDP 输入 → isTrusted=true，同时喂给数美的行为采集）
 *
 * 注意：点对位置只是及格线。数美还会给轨迹、时序、设备指纹打分，
 * 最终由它自己提交并决定发不发 rid —— 这里只负责「点得准 + 点得像人」。
 */

const SOLVER = path.resolve(process.cwd(), 'tools/captcha/shumei_select.py');

/** 找验证码题面图所在区域（数美的面板在不同版本里容器名不一样，逐个探测） */
export async function findChallengeBox(page) {
  const candidates = await page.evaluate(() => {
    const out = [];
    const push = (el, kind) => {
      const r = el.getBoundingClientRect();
      if (r.width > 120 && r.height > 90 && r.width < 900) {
        out.push({ kind, x: r.x, y: r.y, width: r.width, height: r.height });
      }
    };
    document.querySelectorAll('iframe').forEach((f) => push(f, 'iframe'));
    document.querySelectorAll('canvas,img,div').forEach((d) => {
      const cls = String(d.className || '');
      const id = String(d.id || '');
      if (/shumei|captcha|sm-|challenge/i.test(cls) || /shumei|captcha/i.test(id)) push(d, 'node');
    });
    return out;
  });
  // 取面积最像题面图的那块（200~700 宽）
  return candidates.sort((a, b) => Math.abs(a.width - 360) - Math.abs(b.width - 360))[0] || null;
}

/** 读题面文字 */
export async function readPrompt(page) {
  const t = await page
    .evaluate(() => {
      const nodes = [...document.querySelectorAll('div,span,p')];
      const hit = nodes.find((n) => /点击图中|请选择|请依次点击/.test(n.textContent || '') && (n.textContent || '').length < 80);
      return hit ? hit.textContent.trim() : '';
    })
    .catch(() => '');
  return t;
}

/** 截图 → 求解 → 返回页面绝对坐标 */
export async function solveChallenge(page, { log = () => {}, debugDir } = {}) {
  const prompt = await readPrompt(page);
  if (!prompt) return { ok: false, reason: 'no_prompt' };

  const box = await findChallengeBox(page);
  if (!box) return { ok: false, reason: 'no_box', prompt };

  const stamp = Date.now();
  const dir = debugDir || path.join(os.tmpdir(), 'opends-captcha');
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, `shumei-${stamp}.png`);
  await page.screenshot({ path: img, clip: { x: box.x, y: box.y, width: box.width, height: box.height } });

  let pick;
  try {
    const { stdout } = await run(
      'python3',
      [SOLVER, '--img', img, '--prompt', prompt, '--offset', `${box.x},${box.y}`, '--debug', path.join(dir, `annotated-${stamp}.png`)],
      { timeout: 20_000 },
    );
    pick = JSON.parse(stdout).pick;
  } catch (err) {
    return { ok: false, reason: 'solver_failed', prompt, error: err.message };
  }
  if (!pick) return { ok: false, reason: 'no_candidate', prompt };

  log(`验证码题面「${prompt}」→ 点 (${pick.x}, ${pick.y}) [${pick.color}/${pick.shape}]`);
  await humanClick(page, pick.x, pick.y);
  return { ok: true, prompt, pick, shot: img };
}

/** 真人式点击：曲线移动 + 分段减速 + 到位微抖 */
export async function humanClick(page, x, y) {
  const from = (page.__cursor ??= { x: x - 60 - Math.random() * 80, y: y - 40 - Math.random() * 60 });
  const steps = 18 + Math.floor(Math.random() * 16);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const jx = (Math.random() - 0.5) * 2.2;
    const jy = (Math.random() - 0.5) * 2.2;
    await page.mouse.move(from.x + (x - from.x) * e + jx, from.y + (y - from.y) * e + jy);
    await page.waitForTimeout(6 + Math.random() * 14);
  }
  for (let i = 0; i < 2; i += 1) {
    await page.mouse.move(x + (Math.random() - 0.5) * 3, y + (Math.random() - 0.5) * 3);
    await page.waitForTimeout(40 + Math.random() * 80);
  }
  await page.mouse.click(x, y);
  page.__cursor = { x, y };
}

/**
 * 反复解直到验证码消失（数美可能是多轮：select → seq_select）。
 * 返回 true 表示面板已关闭/换页。
 */
export async function solveUntilGone(page, { rounds = 3, log = () => {}, isGone } = {}) {
  for (let i = 1; i <= rounds; i += 1) {
    const res = await solveChallenge(page, { log });
    if (!res.ok) return res;
    await page.waitForTimeout(2200 + Math.random() * 900);
    const gone = await (isGone ? isGone() : defaultGone(page));
    if (gone) return { ok: true, rounds: i };
    log(`第 ${i} 轮后验证码仍在，继续`);
  }
  return { ok: false, reason: 'rounds_exhausted' };
}

async function defaultGone(page) {
  return page
    .evaluate(() => !/点击图中|请选择|请依次点击/.test(document.body.innerText || ''))
    .catch(() => false);
}
