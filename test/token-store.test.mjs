import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openTokenStore, importFromAuthFile } from '../src/token-store.mjs';
import { loadTokenRecords, loadTokens, saveTokens } from '../src/auth.mjs';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-store-'));

test('token 库：增删替换 + 元数据', () => {
  const dataDir = tmp();
  try {
    const store = openTokenStore({ dataDir });
    assert.equal(store.add('tok-a', { source: 'manual' }), true);
    assert.equal(store.add('tok-a', { source: 'manual' }), false, '重复添加不算新增');
    store.add('tok-b', { deviceId: '11111111-2222-4333-8444-555555555555', source: 'login' });
    assert.equal(store.count(), 2);

    const list = store.list();
    assert.deepEqual(list.map((r) => r.token), ['tok-a', 'tok-b']);
    assert.equal(list[1].deviceId, '11111111-2222-4333-8444-555555555555');

    store.replaceAll(['tok-b', 'tok-c']);
    assert.deepEqual(store.list().map((r) => r.token), ['tok-b', 'tok-c']);
    assert.equal(store.remove('tok-b'), true);
    assert.deepEqual(store.list().map((r) => r.token), ['tok-c']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('token 库：空库时从 auth.json 一次性迁移（老用户不掉号池）', () => {
  const dataDir = tmp();
  try {
    const authFile = path.join(dataDir, 'auth.json');
    fs.writeFileSync(authFile, JSON.stringify({ token: 'legacy-1', tokens: ['legacy-1', 'legacy-2'] }));
    const store = openTokenStore({ dataDir });
    assert.equal(store.count(), 0);
    const added = importFromAuthFile(store, authFile);
    assert.equal(added, 2);
    assert.deepEqual(store.list().map((r) => r.token), ['legacy-1', 'legacy-2']);
    assert.equal(store.list()[0].source, 'auth.json');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('auth.loadTokens/saveTokens 以数据库为准，并镜像 auth.json', () => {
  const dataDir = tmp();
  try {
    const config = { dataDir, authFile: path.join(dataDir, 'auth.json') };
    assert.deepEqual(loadTokens(config), []);
    saveTokens(config, ['t1', 't2'], { source: 'manual' });
    assert.deepEqual(loadTokens(config), ['t1', 't2']);
    // 镜像文件仍然存在（方便拷号/回滚）
    const mirror = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
    assert.deepEqual(mirror.tokens, ['t1', 't2']);
    // 带元数据
    const records = loadTokenRecords(config);
    assert.equal(records.length, 2);
    assert.equal(records[0].source, 'manual');
    // 换一批
    saveTokens(config, ['t2', 't3']);
    assert.deepEqual(loadTokens(config), ['t2', 't3']);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
