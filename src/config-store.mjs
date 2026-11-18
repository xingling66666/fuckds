import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { parseEnvText } from './util.mjs';

/**
 * 配置持久化：项目原来把后台设置写回项目根目录的 `.env`，重启才生效。
 *
 * 现在统一落到 `$DATA_DIR/config.db`（SQLite，Node 内置 `node:sqlite`，无第三方依赖）：
 * - 表 settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)；
 * - 同一个数据库路径在进程内复用同一个连接（admin/测试里会反复 loadConfig）；
 * - 首次创建且表为空时，把项目根目录既有 `.env` 的键值原样迁进来，之后不再读写 `.env`。
 *
 * 只负责「存」，值的解析/映射仍在 config.mjs（loadConfig / applyConfigValues），
 * 保证启动加载和后台保存走同一套逻辑。
 */

const ROOT = path.resolve(import.meta.dirname, '..');

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/** @type {Map<string, ReturnType<typeof createStore>>} */
const stores = new Map();

/**
 * 打开（或复用）配置数据库。
 *
 * @param {object} options
 * @param {string} options.dataDir 数据目录（`data/`），数据库文件固定为 `<dataDir>/config.db`
 * @param {string} [options.rootDir] 项目根目录，只用于首次迁移时找 `.env`（默认本模块上一级）
 * @param {boolean} [options.migrate=true] 首次建库时是否从 `.env` 迁移
 */
export function openConfigStore({ dataDir, rootDir = ROOT, migrate = true } = {}) {
  if (!dataDir) throw new Error('openConfigStore 需要 dataDir');
  const dir = path.resolve(dataDir);
  const dbFile = path.join(dir, 'config.db');

  const cached = stores.get(dbFile);
  if (cached) {
    // 表还是空的说明此前没迁移过（例如第一次打开时项目还没有 .env），补一次；迁移后不再读 .env。
    if (migrate && cached.isEmpty()) migrateEnvToStore(cached, rootDir);
    return cached;
  }

  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(CREATE_TABLE_SQL);

  const selectValue = db.prepare('SELECT value FROM settings WHERE key = ?');
  const selectAll = db.prepare('SELECT key, value FROM settings ORDER BY key');
  const countRows = db.prepare('SELECT COUNT(*) AS n FROM settings');
  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const store = {
    dbFile,
    dataDir: dir,

    /** @returns {string|null} */
    get(key) {
      const row = selectValue.get(String(key));
      return row ? row.value : null;
    },

    /** @returns {Record<string, string>} */
    getAll() {
      const out = {};
      for (const row of selectAll.all()) out[row.key] = row.value;
      return out;
    },

    /** 批量写入（单事务），返回值是实际写入的 key 列表 */
    setMany(updates = {}) {
      const entries = Object.entries(updates ?? {}).filter(
        ([, value]) => value !== undefined && value !== null,
      );
      if (!entries.length) return [];
      const now = new Date().toISOString();
      db.exec('BEGIN');
      try {
        for (const [key, value] of entries) upsert.run(String(key), String(value), now);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return entries.map(([key]) => key);
    },

    set(key, value) {
      store.setMany({ [key]: value });
    },

    count() {
      return Number(countRows.get()?.n ?? 0);
    },

    isEmpty() {
      return store.count() === 0;
    },

    /** 关闭连接并移出进程内缓存（测试用临时目录时会用到） */
    close() {
      if (stores.get(dbFile) === store) stores.delete(dbFile);
      db.close();
    },
  };

  stores.set(dbFile, store);
  if (migrate) migrateEnvToStore(store, rootDir);
  return store;
}

/**
 * 首次迁移：表为空时把项目根 `.env` 的值搬进 SQLite。
 *
 * 只在表为空时执行 —— 一旦有任何一条配置（迁移或后台保存写入），就再也不会读 `.env`。
 *
 * @returns {{migrated: boolean, keys: string[], envFile?: string}}
 */
export function migrateEnvToStore(store, rootDir = ROOT) {
  if (!store.isEmpty()) return { migrated: false, keys: [] };
  const envFile = path.join(rootDir, '.env');
  let text;
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    // 没有 .env 很正常：所有配置都有默认值，只有 token 需要 npm run auth
    return { migrated: false, keys: [] };
  }
  const parsed = parseEnvText(text);
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined);
  if (!entries.length) return { migrated: false, keys: [], envFile };
  const keys = store.setMany(Object.fromEntries(entries));
  return { migrated: true, keys, envFile };
}
