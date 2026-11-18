import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseProfile, saveProfile, summarizeProfile } from '../src/profile.mjs';

const DUMP = {
  userToken: JSON.stringify({ value: '00U/1Nyu/gZ9WZYzZE2cch1foQnjvUBmHASHJK2mmMEsW2BDd2/9LFq4KWYrXPdR', __version: '0' }),
  'deepseek-device-id:chat': '2d70ce31-d4ff-43f6-b7c2-51e857867812',
  '.thumbcache_6b2e5483f9d858d7c661c5e276b6a6ae': 'gRYbfnZMZW+fb/53VnwBi0EKlNpUQtZl02ZOzEgUM/lZ/N1CXtpRUu334pKey4af1TZeRk1bdTA5FbT/tsEBig==',
  smidV2: '20261113152106bf029c63dbd49b9830e06788abbf17e5008845d1686893e50',
  hif_leim_cached: JSON.stringify('leim-token'),
  hif_dliq_cached: JSON.stringify('dliq-token'),
  settingsJwt: JSON.stringify({ value: { ownerHash: 'f02a8e30bb882', jwt: 'jwe.jwt.here' }, __version: '0' }),
  __appKit_userInfo: JSON.stringify({ value: { id: '604b0f8f-bb38-4f76-8ee8-2e2939185af9' }, __version: '0' }),
  thinkingEnabled: JSON.stringify({ value: false, __version: '2' }),
  searchEnabled: JSON.stringify({ value: true, __version: '0' }),
};

test('parseProfile：copy(localStorage) 整包能解析出全部关键字段', () => {
  const p = parseProfile(JSON.stringify(DUMP));
  assert.equal(p.token, '00U/1Nyu/gZ9WZYzZE2cch1foQnjvUBmHASHJK2mmMEsW2BDd2/9LFq4KWYrXPdR');
  assert.equal(p.deviceId, '2d70ce31-d4ff-43f6-b7c2-51e857867812');
  assert.equal(p.userId, '604b0f8f-bb38-4f76-8ee8-2e2939185af9');
  assert.ok(p.shumeiSeed?.key.startsWith('.thumbcache_'));
  assert.equal(p.smidV2.startsWith('2026'), true);
  assert.equal(p.hif.leim, 'leim-token');
  assert.equal(p.hif.dliq, 'dliq-token');
  assert.equal(p.settingsJwt.ownerHash, 'f02a8e30bb882');
  assert.equal(p.thinking, false);
  assert.equal(p.search, true);
  assert.deepEqual(p.warnings, []);
});

test('parseProfile：只给 token 时给出缺设备特征的警告', () => {
  const p = parseProfile('abcDEF123');
  assert.equal(p.token, 'abcDEF123');
  assert.equal(p.deviceId, '');
  assert.equal(p.warnings.length > 0, true);
});

test('parseProfile：直接贴 userToken 的 JSON 也能认', () => {
  const p = parseProfile(JSON.stringify({ value: 'tok123', __version: '0' }));
  assert.equal(p.token, 'tok123');
});

test('parseProfile：{ownerHash,jwt} 形态取 jwt 兜底', () => {
  const p = parseProfile(JSON.stringify({ value: { ownerHash: 'x', jwt: 'jwt-only' }, __version: '0' }));
  assert.equal(p.token, 'jwt-only');
});

test('saveProfile：落盘到 data/profiles 且内容是完整快照', () => {
  // 注：loadProfile / listProfiles / removeProfile 随「真人档案导入」链路一起删掉了，
  // 现在只有注册流程会调 saveProfile 留档，所以这里直接读文件校验。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-'));
  const p = parseProfile(JSON.stringify(DUMP));
  const file = saveProfile(dir, p);
  assert.equal(path.dirname(file), path.join(dir, 'profiles'));
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(back.deviceId, p.deviceId);
  assert.equal(Object.keys(back.storage).length, Object.keys(p.storage).length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('summarizeProfile 不泄露完整 token', () => {
  const s = summarizeProfile(parseProfile(JSON.stringify(DUMP)));
  assert.equal(s.token.includes('00U/1Nyu/gZ9WZYzZE2cch1foQnjvUBmHASHJK2mmMEsW2BDd2'), false);
  assert.equal(s.hasShumei, true);
});
