import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeUserToken, splitTokenCandidates } from '../src/auth.mjs';

// DeepSeek localStorage.userToken 里的真实形态
const TOKEN = 'oxJejK6By45slwtl8pitbGH8HPpsWoyBRHopdLpwBuCwiEKlqZr5Uml6R5P2wTeI';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const LS_JSON = `{"value":"${TOKEN}","__version":"0"}`;

/* ---------------- 回归：粘贴 localStorage JSON 不能被逗号切开 ---------------- */

test('splitTokenCandidates: 单独的 localStorage JSON 只得到一个候选', () => {
  const candidates = splitTokenCandidates(LS_JSON);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0], LS_JSON);
  // 旧实现会按逗号切成 ['{"value":"...', '"__version":"0"}'] 的多段
  assert.deepEqual(candidates.map(normalizeUserToken), [TOKEN]);
});

test('normalizeUserToken: localStorage JSON 取 value 字段', () => {
  assert.equal(normalizeUserToken(LS_JSON), TOKEN);
});

test('JSON + 换行 + 裸 token → 2 个 token', () => {
  const input = `${LS_JSON}\n${OTHER}`;
  const candidates = splitTokenCandidates(input);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map(normalizeUserToken), [TOKEN, OTHER]);
});

test('JSON 内部含逗号/空格/转义引号也不会被切开', () => {
  assert.deepEqual(splitTokenCandidates('{"value":"abc,def ghi"}'), ['{"value":"abc,def ghi"}']);
  assert.deepEqual(splitTokenCandidates('{"value":"a\\"b,c"}'), ['{"value":"a\\"b,c"}']);
  // 嵌套对象/数组同样保持完整
  assert.deepEqual(splitTokenCandidates('{"value":"x","meta":{"a":[1,2]}}'), ['{"value":"x","meta":{"a":[1,2]}}']);
});

/* ---------------- 普通分隔符 ---------------- */

test('逗号 / 空格 / 分号分隔多个裸 token → 正确数量', () => {
  assert.deepEqual(splitTokenCandidates(`${TOKEN},${OTHER}`), [TOKEN, OTHER]);
  assert.deepEqual(splitTokenCandidates(`${TOKEN} ${OTHER}`), [TOKEN, OTHER]);
  assert.deepEqual(splitTokenCandidates(`${TOKEN};${OTHER}`), [TOKEN, OTHER]);
  const mixed = splitTokenCandidates(`  ${TOKEN},\n ${OTHER} ;\t${TOKEN}  `);
  assert.deepEqual(mixed, [TOKEN, OTHER, TOKEN]);
});

test('splitTokenCandidates: 空输入 / 纯分隔符 / 空数组 → 空列表', () => {
  assert.deepEqual(splitTokenCandidates(''), []);
  assert.deepEqual(splitTokenCandidates('   \n , ;  '), []);
  assert.deepEqual(splitTokenCandidates(null), []);
  assert.deepEqual(splitTokenCandidates(undefined), []);
  assert.deepEqual(splitTokenCandidates([]), []);
});

test('splitTokenCandidates: 数组输入逐项 trim，不切分', () => {
  assert.deepEqual(splitTokenCandidates(['  a  ', '', 'b']), ['a', 'b']);
  // 数组里即使是含逗号的原始 JSON 也原样保留，交给 normalize 处理
  assert.deepEqual(splitTokenCandidates([LS_JSON]), [LS_JSON]);
});

/* ---------------- 各种合法 token 形态 ---------------- */

test('normalizeUserToken: 裸 token / Bearer / 引号包裹都能用', () => {
  assert.equal(normalizeUserToken(TOKEN), TOKEN);
  assert.equal(normalizeUserToken(`Bearer ${TOKEN}`), TOKEN);
  assert.equal(normalizeUserToken(`bearer   ${TOKEN}`), TOKEN);
  assert.equal(normalizeUserToken(`"${TOKEN}"`), TOKEN);
  assert.equal(normalizeUserToken(`'${TOKEN}'`), TOKEN);
  assert.equal(normalizeUserToken(`  ${TOKEN}  `), TOKEN);
});

test('normalizeUserToken: 太短、空、非字符串仍然报错', () => {
  assert.throws(() => normalizeUserToken('short'), /太短/);
  assert.throws(() => normalizeUserToken('   '), /为空/);
  assert.throws(() => normalizeUserToken(123), /必须是字符串/);
});

/* ---------------- 残缺 JSON / 碎片必须报错，不能静默入池 ---------------- */

test('normalizeUserToken: 残缺 JSON 抛清晰错误', () => {
  assert.throws(
    () => normalizeUserToken('{"value":"abc'),
    /localStorage JSON.*没有解析出 value 字段/,
  );
  assert.throws(
    () => normalizeUserToken('{"value":"' + TOKEN),
    /localStorage JSON.*没有解析出 value 字段/,
  );
});

test('normalizeUserToken: 合法 JSON 但没有字符串 value 也要报错', () => {
  assert.throws(() => normalizeUserToken('{"foo":1}'), /没有解析出 value 字段/);
  assert.throws(() => normalizeUserToken(`{"value":123}`), /没有解析出 value 字段/);
  assert.throws(() => normalizeUserToken(`{"value":""}`), /没有解析出 value 字段/);
});

test('normalizeUserToken: "__version":"0"} 碎片不能当 token', () => {
  assert.throws(() => normalizeUserToken('"__version":"0"}'), /残留了 JSON 结构字符/);
});

test('normalizeUserToken: 其他残留 JSON 结构字符也拒绝', () => {
  assert.throws(() => normalizeUserToken(`{"value":${TOKEN}}}`), /没有解析出 value 字段/);
  assert.throws(() => normalizeUserToken(`"${TOKEN}`), /残留了 JSON 结构字符/);
  assert.throws(() => normalizeUserToken(`${TOKEN}}`), /残留了 JSON 结构字符/);
  assert.throws(() => normalizeUserToken(`'${TOKEN}}`), /残留了 JSON 结构字符/);
});

test('回归：管理后台粘贴的整段 JSON 走 split + normalize 只产生 1 个 token', () => {
  // 模拟 src/admin/routes.mjs 的 parseTokenInput 对字符串输入的处理
  const tokens = splitTokenCandidates(LS_JSON).map((raw) => normalizeUserToken(raw));
  assert.deepEqual(tokens, [TOKEN]);
});
