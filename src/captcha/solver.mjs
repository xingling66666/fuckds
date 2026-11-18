/**
 * 验证码解题器（不依赖打码平台）。
 *
 * 思路（用户提出的「左脚踩右脚」）：**用 DeepSeek 自己看验证码图**。
 * 号池里只要有一个有效 token，就能让它把 hCaptcha 的九宫格截图当图片消息发过去，
 * 问它「哪几格符合题面」，拿回编号后由脚本点击。模型是它自己的视觉能力，不花额外的钱。
 *
 * 三种解题器：
 *   - deepseek：调号池里的有效 token 识图（需要至少一个可用号）
 *   - human   ：把截图存到文件，人在终端/聊天里报编号（没有可用号时的兜底）
 *   - none    ：直接抛错，交给上层决定
 *
 * 注意：这里只负责「识别 → 返回编号」，点击/提交在 hcaptcha.mjs 里。
 */

/** 从模型输出里抠出 1..9 的格子编号（容错各种写法） */
export function parseTileNumbers(text, max = 9) {
  const raw = String(text || '');
  // 常见输出：`2,5`、`2、5、7`、`[2, 5]`、`第2格和第5格`、`2 5 7`
  // 但要排除「需要选 3 个」「9 格」这类**数量词**，否则会把 3 当成格子编号。
  const COUNT_NOUN = /^(个|张|块|次|行|列|组|道|步)/;
  const nums = [];
  for (const m of raw.matchAll(/\d+/g)) {
    const n = Number(m[0]);
    if (!Number.isFinite(n) || n < 1 || n > max) continue;
    const rest = raw.slice((m.index ?? 0) + m[0].length);
    if (COUNT_NOUN.test(rest.trimStart())) continue; // 后面跟「个/张/格」→ 数量
    // 「第N格」里那个「格」是紧跟数字的，属于格子编号，不能排除，所以只排除「个/张/块…」
    nums.push(n);
  }
  const unique = [...new Set(nums)];
  return unique.sort((a, b) => a - b);
}

/** 要求模型只回编号的提示词 */
export function buildPrompt(challengeText) {
  return [
    '你在帮我解一道 hCaptcha 人机验证题。我会给你一张九宫格截图。',
    `题面是：「${challengeText || '（未识别到文字）'}」`,
    '',
    '规则：',
    '- 九宫格按从左到右、从上到下编号为 1~9（第一行 1 2 3，第二行 4 5 6，第三行 7 8 9）。',
    '- 选出所有符合题面的格子。',
    '- 只输出编号，用英文逗号分隔，例如：2,5,7',
    '- 不要任何解释、不要标点以外的文字。',
  ].join('\n');
}

/** 把截图 buffer 编成 data URL（引擎的 images 字段吃这个格式） */
export function toDataUrl(buffer, mime = 'image/png') {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

/**
 * 用引擎（DeepSeek 直连）识图。
 *
 * @param {object} options
 * @param {{chat: Function}} options.engine 已构造好的引擎（DirectEngine / DeepSeekWeb）
 * @param {Buffer} options.image            九宫格截图
 * @param {string} options.challengeText    题面文字
 * @param {object} [options.log]
 * @returns {Promise<number[]>} 需要点击的格子编号
 */
export async function solveWithEngine({ engine, image, challengeText, log = { info() {}, warn() {} } }) {
  const prompt = buildPrompt(challengeText);
  const result = await engine.chat({
    prompt,
    images: [{ url: toDataUrl(image) }],
    thinking: false,
    meta: { purpose: 'captcha-solver' },
  });
  const text = String(result?.text || '');
  const indices = parseTileNumbers(text);
  log.info?.('识图结果', { raw: text.slice(0, 80), indices });
  if (!indices.length) {
    throw new Error(`模型没给出可用编号（原始输出：${text.slice(0, 120)}）`);
  }
  return indices;
}

/**
 * 人工解题：把截图存盘，等调用方给编号（终端交互或聊天里看图报数）。
 * @param {object} options
 * @param {Buffer} options.image
 * @param {string} options.savePath
 * @param {(question: string) => Promise<string>} options.ask 询问函数（CLI 里用 readline）
 */
export async function solveWithHuman({ image, savePath, ask, log = { info() {} } }) {
  const fs = await import('node:fs');
  fs.writeFileSync(savePath, image);
  log.info?.(`验证码截图已保存：${savePath}`);
  const answer = await ask(
    `请看 ${savePath}，题面是 hCaptcha 九宫格（1~9 行优先）。需要点击哪几格？（逗号分隔，如 2,5）`,
  );
  const indices = parseTileNumbers(answer);
  if (!indices.length) throw new Error(`输入的格子编号不合法：${answer}`);
  return indices;
}
