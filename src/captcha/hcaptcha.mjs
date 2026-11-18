/**
 * hCaptcha 题面解析与点击（不依赖任何打码平台）。
 *
 * 实测（2026-11，chat.deepseek.com 注册页）hCaptcha 会给两种题：
 *   1. **图像多选**：「选出所有在室温下会融化的物体」+ 3x3 图片网格
 *   2. **拖拽修复**：「将匹配的图块拖入正确的空位以修复图案」+ 网格 + 右侧可拖图块
 *
 * 本模块只做「几何 + 交互」，不含任何识别模型：
 *   - 在 hCaptcha iframe 里量出网格每一格的中心坐标；
 *   - 按调用方给的格子编号去点击 / 拖拽；
 *   - 提交后轮询 `textarea[name=h-captcha-response]` 是否拿到 token。
 *
 * 识别层可以是：本地视觉模型（Ollama）、调用方自己看图给编号、或几何比对。
 */

/** hCaptcha 挑战面板的典型尺寸（3x3 网格约 300x300，居中） */
export const GRID_GEOMETRY = {
  /** 3x3 网格边长（CSS px），hCaptcha 标准面板约 300 */
  gridSize: 300,
  /** 每格尺寸 */
  cellSize: 100,
};

/**
 * 找出 hCaptcha 挑战 iframe（frame=challenge 的那个，不是 checkbox 的）。
 * @param {import('playwright').Page} page
 * @returns {import('playwright').Frame|null}
 */
export function findChallengeFrame(page) {
  const frames = page.frames().filter((f) => f.url().includes('hcaptcha'));
  // 优先取带 frame=challenge 的；再退化为尺寸最大的那个
  const challenge = frames.find((f) => f.url().includes('frame=challenge'));
  if (challenge) return challenge;
  return frames[frames.length - 1] || null;
}

/** 挑战面板里那行题面文字（中文/英文都取） */
export async function readChallengePrompt(frame) {
  return frame
    .evaluate(() => {
      const els = [...document.querySelectorAll('div, span, h2, p')];
      const hit = els.find((el) => el.children.length === 0 && (el.textContent || '').trim().length > 4);
      return hit ? hit.textContent.trim() : '';
    })
    .catch(() => '');
}

/**
 * 量出九宫格在**页面坐标系**里的位置。
 *
 * 实测：hCaptcha 的格子不是 `<img>`，而是一堆 `div { background-image: url(...) }`。
 * 所以这里直接量「带背景图的 div」，按尺寸聚类（格子大小一致）、再按 y→x 排序，
 * 取前 9 个作为 1~9 号格子。比「假设 3x3 等分」可靠得多。
 *
 * @returns {Promise<null|{cells:{x:number,y:number,w:number,h:number}[], centers:{x:number,y:number}[], origin:{x:number,y:number}, cellW:number, cellH:number}>}
 */
export async function measureGrid(page, frame) {
  const raw = await frame
    .evaluate(() => {
      const tiles = [];
      for (const el of document.querySelectorAll('div, a, button')) {
        const style = getComputedStyle(el);
        if (!style.backgroundImage || style.backgroundImage === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) continue;
        if (Math.abs(r.width - r.height) > 12) continue; // 格子基本是正方形
        tiles.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      }
      return tiles;
    })
    .catch(() => []);

  if (!raw || raw.length < 6) return null;

  // 尺寸聚类：取出现最多的尺寸作为「格子尺寸」
  const keyOf = (t) => `${Math.round(t.w)}x${Math.round(t.h)}`;
  const counts = new Map();
  for (const t of raw) counts.set(keyOf(t), (counts.get(keyOf(t)) || 0) + 1);
  const [bestKey] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const cells = raw
    .filter((t) => keyOf(t) === bestKey)
    // 行优先：先按 y 分行（容差半个格子），再按 x
    .sort((a, b) => Math.round(a.y / 10) - Math.round(b.y / 10) || a.x - b.x)
    .slice(0, 9);

  if (cells.length < 6) return null;

  // iframe 在页面里的偏移
  const offset = await page
    .evaluate(() => {
      const ifr = [...document.querySelectorAll('iframe')].find((f) => f.src.includes('frame=challenge'));
      if (!ifr) return { x: 0, y: 0 };
      const r = ifr.getBoundingClientRect();
      return { x: r.x, y: r.y };
    })
    .catch(() => ({ x: 0, y: 0 }));

  const centers = cells.map((t) => ({
    x: offset.x + t.x + t.w / 2,
    y: offset.y + t.y + t.h / 2,
  }));
  const first = cells[0];
  return {
    cells,
    centers,
    origin: { x: offset.x + first.x, y: offset.y + first.y },
    cellW: first.w,
    cellH: first.h,
    /** 第 n 格（1..9，行优先）在**页面坐标系**里的中心 */
    centerOf(n) {
      const idx = Math.max(1, Math.min(centers.length, Number(n))) - 1;
      return centers[idx];
    },
  };
}

/** 按编号依次点击（编号 1..9，行优先） */
export async function clickTiles(page, grid, indices, { delayMs = 350 } = {}) {
  const clicked = [];
  for (const n of indices) {
    const p = grid.centerOf(n);
    await page.mouse.click(p.x, p.y);
    clicked.push(n);
    await page.waitForTimeout(delayMs);
  }
  return clicked;
}

/** 挑战是否已通过（token 出现 或 面板消失） */
export async function isChallengeSolved(page) {
  const token = await page
    .evaluate(() => {
      const ta = document.querySelector('textarea[name="h-captcha-response"]');
      return ta ? String(ta.value || '') : '';
    })
    .catch(() => '');
  if (token && token.length > 20) return true;
  const stillThere = page.frames().some((f) => f.url().includes('frame=challenge'));
  return !stillThere;
}

/** 等挑战通过（给人工/模型多轮机会），返回 token 或 null */
export async function waitForChallengeSolved(page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await page
      .evaluate(() => {
        const ta = document.querySelector('textarea[name="h-captcha-response"]');
        return ta ? String(ta.value || '') : '';
      })
      .catch(() => '');
    if (token && token.length > 20) return token;
    await page.waitForTimeout(1500);
  }
  return null;
}

/** 面板上的「跳过 / 验证 / 提交」按钮（不同主题文案不同） */
export async function clickSubmitOrSkip(page) {
  const labels = ['跳过', '提交', '验证', 'Verify', 'Submit', 'Skip'];
  for (const label of labels) {
    const btn = page.getByText(label, { exact: true }).last();
    const count = await btn.count().catch(() => 0);
    if (count) {
      await btn.click({ timeout: 3_000 }).catch(() => {});
      return label;
    }
  }
  return null;
}
