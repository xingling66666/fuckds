import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, parseTileNumbers, solveWithEngine, solveWithHuman, toDataUrl } from '../src/captcha/solver.mjs';
import { GRID_GEOMETRY, findChallengeFrame } from '../src/captcha/hcaptcha.mjs';

test('parseTileNumbers：各种模型输出格式都能抠出编号', () => {
  assert.deepEqual(parseTileNumbers('2,5'), [2, 5]);
  assert.deepEqual(parseTileNumbers('2、5、7'), [2, 5, 7]);
  assert.deepEqual(parseTileNumbers('[2, 5]'), [2, 5]);
  assert.deepEqual(parseTileNumbers('第2格和第5格'), [2, 5]);
  assert.deepEqual(parseTileNumbers('需要选 3 个：1 5 9'), [1, 5, 9]);
  assert.deepEqual(parseTileNumbers('5,2,5,2'), [2, 5], '去重并升序');
  assert.deepEqual(parseTileNumbers('没有'), []);
  assert.deepEqual(parseTileNumbers(''), []);
  // 超出 1..9 的数字（比如「3x3」的 3 仍合法，但 12 要丢弃）
  assert.deepEqual(parseTileNumbers('12, 4'), [4]);
});

test('buildPrompt：把题面塞进提示词，并强调只输出编号', () => {
  const p = buildPrompt('选出所有在室温下会融化的物体');
  assert.match(p, /选出所有在室温下会融化的物体/);
  assert.match(p, /1~9/);
  assert.match(p, /只输出编号/);
  assert.match(buildPrompt(''), /未识别到文字/);
});

test('toDataUrl：image/png base64 协议头', () => {
  const url = toDataUrl(Buffer.from('abc'));
  assert.equal(url, `data:image/png;base64,${Buffer.from('abc').toString('base64')}`);
});

test('solveWithEngine：用引擎识图 → 编号；模型胡说时报错', async () => {
  const seen = [];
  const engine = {
    async chat(req) {
      seen.push(req);
      return { text: '2,5' };
    },
  };
  const indices = await solveWithEngine({
    engine,
    image: Buffer.from('png-bytes'),
    challengeText: '会融化的物体',
    log: { info() {}, warn() {} },
  });
  assert.deepEqual(indices, [2, 5]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].prompt, /会融化的物体/);
  assert.match(seen[0].images[0].url, /^data:image\/png;base64,/);
  assert.equal(seen[0].thinking, false);

  await assert.rejects(
    () => solveWithEngine({ engine: { async chat() { return { text: '看不懂' }; } }, image: Buffer.from('x'), challengeText: '' }),
    /没给出可用编号/,
  );
});

test('solveWithHuman：截图落盘 + 解析人工输入', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-'));
  const savePath = path.join(dir, 'shot.png');
  try {
    const indices = await solveWithHuman({
      image: Buffer.from('fake-png'),
      savePath,
      ask: async () => '1, 6, 9',
      log: { info() {} },
    });
    assert.deepEqual(indices, [1, 6, 9]);
    assert.equal(fs.existsSync(savePath), true);
    await assert.rejects(
      () => solveWithHuman({ image: Buffer.from('x'), savePath, ask: async () => '不知道', log: { info() {} } }),
      /不合法/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hCaptcha 几何常量与 frame 查找在无页面时是安全的', () => {
  assert.equal(GRID_GEOMETRY.cellSize, 100);
  const fakePage = { frames: () => [] };
  assert.equal(findChallengeFrame(fakePage), null);
  const withFrame = {
    frames: () => [
      { url: () => 'https://newassets.hcaptcha.com/x/static/hcaptcha.html#frame=checkbox' },
      { url: () => 'https://newassets.hcaptcha.com/x/static/hcaptcha.html#frame=challenge&id=1' },
    ],
  };
  assert.match(findChallengeFrame(withFrame).url(), /frame=challenge/);
});
