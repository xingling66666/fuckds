import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { applyConfigValues, loadConfig } from '../src/config.mjs';
import { openConfigStore } from '../src/config-store.mjs';

/**
 * 配置持久化：SQLite（data/config.db）+ 后台保存即时生效。
 *
 * 全部用 os.tmpdir() 下的临时目录，不碰项目真实 data/ 和 .env。
 */

function tempDir(t, prefix = 'fuckds-config-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力清理 */
    }
  });
  return dir;
}

function writeDotEnv(rootDir, text) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.env'), text);
}

function safeClose(store) {
  try {
    store?.close?.();
  } catch {
    /* 已关闭 */
  }
}

test('SQLite：建表、读写、updated_at', (t) => {
  const dir = tempDir(t);
  const store = openConfigStore({ dataDir: path.join(dir, 'data'), rootDir: path.join(dir, 'root') });
  try {
    assert.equal(store.get('PORT'), null);
    assert.deepEqual(store.getAll(), {});
    assert.equal(store.count(), 0);

    store.setMany({ PORT: '9999', LOG_LEVEL: 'debug' });
    assert.equal(store.get('PORT'), '9999');
    assert.deepEqual(store.getAll(), { PORT: '9999', LOG_LEVEL: 'debug' });
    assert.equal(store.count(), 2);

    // 覆盖写（ON CONFLICT DO UPDATE）而不是报主键冲突
    store.set('PORT', '8888');
    assert.equal(store.get('PORT'), '8888');

    // 直接用第二个连接检查表结构和 updated_at
    const db = new DatabaseSync(store.dbFile);
    try {
      const columns = db.prepare('PRAGMA table_info(settings)').all().map((row) => row.name);
      assert.deepEqual(columns, ['key', 'value', 'updated_at']);
      const row = db.prepare('SELECT key, value, updated_at FROM settings WHERE key = ?').get('PORT');
      assert.equal(row.value, '8888');
      assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } finally {
      db.close();
    }
  } finally {
    safeClose(store);
  }
});

test('同一个数据库路径复用同一个连接，close 后可以重新打开', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  const rootDir = path.join(dir, 'root');
  const store = openConfigStore({ dataDir, rootDir });
  assert.equal(openConfigStore({ dataDir, rootDir }), store);
  safeClose(store);
  const reopened = openConfigStore({ dataDir, rootDir });
  try {
    assert.notEqual(reopened, store);
    assert.deepEqual(reopened.getAll(), {});
  } finally {
    safeClose(reopened);
  }
});

test('SQLite：首次为空时从项目根 .env 迁移，之后不再读写 .env', (t) => {
  const dir = tempDir(t);
  const rootDir = path.join(dir, 'root');
  const dataDir = path.join(dir, 'data');
  writeDotEnv(rootDir, 'ENGINE=browser\nPORT=9999\nQUOTED="a b"\n# 注释不会被解析\n');

  const first = openConfigStore({ dataDir, rootDir });
  try {
    assert.deepEqual(first.getAll(), { ENGINE: 'browser', PORT: '9999', QUOTED: 'a b' });
  } finally {
    safeClose(first);
  }

  // 迁移完成后改 .env：再打开也不能重新迁移（表非空）
  writeDotEnv(rootDir, 'ENGINE=direct\nPORT=1111\n');
  const second = openConfigStore({ dataDir, rootDir });
  try {
    assert.equal(second.get('ENGINE'), 'browser');
    assert.equal(second.get('PORT'), '9999');

    // 后台保存后关掉重开：仍是 SQLite 里的值，说明 .env 不参与后续读取
    second.setMany({ ENGINE: 'auto' });
  } finally {
    safeClose(second);
  }

  const third = openConfigStore({ dataDir, rootDir });
  try {
    assert.equal(third.get('ENGINE'), 'auto');
    assert.equal(third.get('PORT'), '9999');
  } finally {
    safeClose(third);
  }
});

test('SQLite：表为空且没有 .env 时正常打开为空库', (t) => {
  const dir = tempDir(t);
  const store = openConfigStore({ dataDir: path.join(dir, 'data'), rootDir: path.join(dir, 'missing-root') });
  try {
    assert.deepEqual(store.getAll(), {});
    assert.equal(fs.existsSync(store.dbFile), true);
  } finally {
    safeClose(store);
  }
});

test('loadConfig 优先级：默认值 < SQLite < 传入 env', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  const rootDir = path.join(dir, 'root');
  const store = openConfigStore({ dataDir, rootDir });
  try {
    store.setMany({
      ENGINE: 'browser',
      PORT: '9999',
      LOG_LEVEL: 'debug',
      MAX_PROMPT_CHARS: '4321',
      API_KEY: 'db-key',
    });

    const config = loadConfig({ DATA_DIR: dataDir, PORT: '3333', LOG_LEVEL: 'warn' }, { store });
    try {
      // SQLite 覆盖默认值
      assert.equal(config.runtime.maxPromptChars, 4321);
      assert.equal(config.server.apiKey, 'db-key');
      // 传入 env 再覆盖 SQLite
      assert.equal(config.server.port, 3333);
      assert.equal(config.logLevel, 'warn');
      // 都没给就是默认值
      assert.equal(config.deepseek.search, false);
      assert.equal(config.runtime.concurrency, 1);
      assert.equal(config.runtime.queueLimit, 64);
      assert.equal(config.dbFile, path.join(dataDir, 'config.db'));
      assert.equal(config.store, store);
    } finally {
      safeClose(config.store === store ? null : config.store);
    }
  } finally {
    safeClose(store);
  }
});

test('applyConfigValues：原地热更运行中 config（后台保存路径）', (t) => {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data');
  const rootDir = path.join(dir, 'root');
  const store = openConfigStore({ dataDir, rootDir });
  try {
    const config = loadConfig({ DATA_DIR: dataDir }, { store });
    const sameObject = config;

    const updates = {
      API_KEY: 'hot-key-123',
      DEEPSEEK_SEARCH: 'true',
      DEFAULT_MODEL: 'deepseek-reasoner',
      MAX_PROMPT_CHARS: '5000',
      MAX_ATTACHMENT_CHARS: '7000',
      OVERFLOW_TO_ATTACHMENT: 'false',
      TOOL_DECL_MODE: 'compact',
      REQUEST_TIMEOUT_MS: '120000',
      FIRST_TOKEN_TIMEOUT_MS: '45000',
      ACCOUNT_COOLDOWN_MS: '12345',
      SAVE_ARTIFACTS: 'false',
      LOG_LEVEL: 'trace',
      CORS_ORIGIN: 'https://example.test',
    };

    // 模拟后台 PUT：先写 SQLite，再原地 apply
    assert.deepEqual(store.setMany(updates), Object.keys(updates));
    const applied = applyConfigValues(config, updates);
    assert.deepEqual(applied.sort(), Object.keys(updates).sort());

    assert.equal(config, sameObject, '必须是原地修改同一个对象（server/engine 持有同一引用）');
    assert.equal(config.server.apiKey, 'hot-key-123');
    assert.equal(config.deepseek.search, true);
    assert.equal(config.deepseek.defaultModel, 'deepseek-reasoner');
    assert.equal(config.runtime.maxPromptChars, 5000);
    assert.equal(config.runtime.maxAttachmentChars, 7000);
    assert.equal(config.runtime.overflowToAttachment, false);
    assert.equal(config.runtime.toolDeclMode, 'compact');
    assert.equal(config.runtime.requestTimeoutMs, 120_000);
    assert.equal(config.runtime.firstTokenTimeoutMs, 45_000);
    assert.equal(config.runtime.accountCooldownMs, 12_345);
    assert.equal(config.runtime.saveArtifacts, false);
    assert.equal(config.logLevel, 'trace');
    assert.equal(config.server.cors, 'https://example.test');

    // 非法值不能把已有配置改坏
    applyConfigValues(config, { PORT: 'abc', CONCURRENCY: '0', TOOL_DECL_MODE: 'nonsense', DEEPSEEK_SEARCH: 'maybe?' });
    assert.equal(config.server.port, 8787);
    assert.equal(config.runtime.concurrency, 1);
    assert.equal(config.runtime.toolDeclMode, 'compact');
    // 旧 bool 语义：非空非真值字符串按 false 处理
    assert.equal(config.deepseek.search, false);

    // 重启后才生效的项也照样写进 config，由 admin 返回 restartRequired 如实标注
    applyConfigValues(config, { HOST: '0.0.0.0', PORT: '9000', CONCURRENCY: '3', QUEUE_LIMIT: '128' });
    assert.equal(config.server.host, '0.0.0.0');
    assert.equal(config.server.port, 9000);
    assert.equal(config.runtime.concurrency, 3);
    assert.equal(config.runtime.queueLimit, 128);

    // 落盘的值可直接被下一次 loadConfig 读回（重启后不丢配置）
    const reloaded = loadConfig({ DATA_DIR: dataDir }, { store });
    assert.equal(reloaded.server.apiKey, 'hot-key-123');
    assert.equal(reloaded.runtime.maxPromptChars, 5000);
    assert.equal(reloaded.runtime.toolDeclMode, 'compact');
  } finally {
    safeClose(store);
  }
});

test('DEEPSEEK_THINKING 控制原生深度思考（默认开启）', (t) => {
  const dir = tempDir(t);
  const store = openConfigStore({ dataDir: path.join(dir, 'data'), rootDir: path.join(dir, 'root') });
  try {
    const on = loadConfig({ DATA_DIR: path.join(dir, 'data') }, { store });
    assert.equal(on.deepseek.thinking, 'always');
    const off = loadConfig({ DATA_DIR: path.join(dir, 'data'), DEEPSEEK_THINKING: 'never' }, { store });
    assert.equal(off.deepseek.thinking, 'never');
  } finally {
    safeClose(store);
  }
});
