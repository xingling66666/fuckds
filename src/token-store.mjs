import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * 号池持久化（SQLite）。
 *
 * 为什么从 auth.json 搬进数据库：
 *  - 后台加号/删号能**热更新**（写库 → 引擎 reloadTokens，不用重启进程）；
 *  - 多实例/多进程读同一份数据不会互相覆盖（JSON 全文重写会丢写）；
 *  - token 和设备 id 天生是一对，放一张表里能保证「同一个号永远是同一台设备」。
 *
 * 表结构：
 *   tokens(token TEXT PRIMARY KEY, created_at TEXT, source TEXT, device_id TEXT, note TEXT)
 *
 * auth.json 仍会同步写一份（给别人拷号、回滚用），但它不再是被读取的权威来源。
 */

const BUSY_TIMEOUT_MS = 3_000;
const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT,
  device_id TEXT,
  note TEXT,
  pool TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'ok',
  revoked_at TEXT,
  revoked_reason TEXT
)`;

/** 号池分两类：
 *  - main   ：正常转发（/v1 对话），会走工具调用、正文生成
 *  - solver ：**只**用来答 hCaptcha 无障碍题，不参与任何业务请求，所以不会被封
 */
export const POOLS = ['main', 'solver'];

/** @type {Map<string, ReturnType<typeof openTokenStore>>} */
const stores = new Map();

export function openTokenStore({ dataDir } = {}) {
  if (!dataDir) throw new Error('openTokenStore 需要 dataDir');
  const dir = path.resolve(dataDir);
  const dbFile = path.join(dir, 'config.db');
  const cached = stores.get(dbFile);
  if (cached) return cached;

  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec(CREATE_TABLE_SQL);
  // 老库迁移：补 pool 列
  try {
    db.exec("ALTER TABLE tokens ADD COLUMN pool TEXT NOT NULL DEFAULT 'main'");
  } catch {
    /* 已存在 */
  }
  // 吊销标记：被上游判失效的号直接打标，之后不再参与选号（不靠轮询试探）
  for (const sql of [
    "ALTER TABLE tokens ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'",
    'ALTER TABLE tokens ADD COLUMN revoked_at TEXT',
    'ALTER TABLE tokens ADD COLUMN revoked_reason TEXT',
  ]) {
    try {
      db.exec(sql);
    } catch {
      /* 已存在 */
    }
  }

  const COLS =
    "token, created_at, source, device_id, note, COALESCE(pool, 'main') AS pool, COALESCE(status, 'ok') AS status, revoked_at, revoked_reason";
  const selectAll = db.prepare(`SELECT ${COLS} FROM tokens ORDER BY created_at ASC`);
  const selectByPool = db.prepare(
    `SELECT ${COLS} FROM tokens WHERE COALESCE(pool,'main') = ? ORDER BY created_at ASC`,
  );
  const selectOne = db.prepare(`SELECT ${COLS} FROM tokens WHERE token = ?`);
  const markRevokedStmt = db.prepare(
    "UPDATE tokens SET status = 'revoked', revoked_at = ?, revoked_reason = ? WHERE token = ? AND COALESCE(status,'ok') <> 'revoked'",
  );
  const markOkStmt = db.prepare(
    "UPDATE tokens SET status = 'ok', revoked_at = NULL, revoked_reason = NULL WHERE token = ?",
  );
  const setPoolStmt = db.prepare("UPDATE tokens SET pool = ? WHERE token = ?");
  const upsert = db.prepare(`
    INSERT INTO tokens (token, created_at, source, device_id, note, pool) VALUES (?, ?, ?, ?, ?, COALESCE(?, 'main'))
    ON CONFLICT(token) DO UPDATE SET
      source = COALESCE(excluded.source, tokens.source),
      device_id = COALESCE(excluded.device_id, tokens.device_id),
      note = COALESCE(excluded.note, tokens.note),
      pool = COALESCE(excluded.pool, tokens.pool)
  `);
  const del = db.prepare('DELETE FROM tokens WHERE token = ?');
  const delOthers = db.prepare('DELETE FROM tokens WHERE token NOT IN (SELECT value FROM json_each(?))');
  const count = db.prepare('SELECT COUNT(*) AS n FROM tokens');

  const store = {
    dbFile,
    /** @returns {{token:string, createdAt:string, source:string|null, deviceId:string|null}[]} */
    list(pool = null) {
      const rows = pool ? selectByPool.all(String(pool)) : selectAll.all();
      return rows.map((row) => ({
        token: row.token,
        createdAt: row.created_at,
        source: row.source,
        deviceId: row.device_id,
        note: row.note,
        pool: row.pool || 'main',
        status: row.status || 'ok',
        revokedAt: row.revoked_at || null,
        revokedReason: row.revoked_reason || null,
      }));
    },
    get(token) {
      const row = selectOne.get(String(token));
      if (!row) return null;
      return {
        token: row.token,
        createdAt: row.created_at,
        source: row.source,
        deviceId: row.device_id,
        note: row.note,
        pool: row.pool || 'main',
        status: row.status || 'ok',
        revokedAt: row.revoked_at || null,
        revokedReason: row.revoked_reason || null,
      };
    },
    /** 标记吊销（已吊销则幂等），返回是否本次新打标 */
    markRevoked(token, reason = '') {
      const value = String(token || '').trim();
      if (!value) return false;
      return markRevokedStmt.run(new Date().toISOString(), String(reason || '').slice(0, 200), value).changes > 0;
    },
    /** 解除吊销（人工确认号又活了过来时用） */
    markOk(token) {
      return markOkStmt.run(String(token || '').trim()).changes > 0;
    },
    /** 只要可用号（默认排除已吊销的） */
    listUsable(pool = null) {
      return this.list(pool).filter((row) => (row.status || 'ok') !== 'revoked');
    },
    /** 把 token 移到某个池（main / solver） */
    setPool(token, pool) {
      const value = String(token || '').trim();
      const target = POOLS.includes(String(pool)) ? String(pool) : 'main';
      return setPoolStmt.run(target, value).changes > 0;
    },
    /** 各池计数 */
    counts() {
      const out = { main: 0, solver: 0, revoked: 0, usable: 0 };
      for (const row of selectAll.all()) {
        const revoked = (row.status || 'ok') === 'revoked';
        if (revoked) {
          out.revoked += 1;
          continue;
        }
        const key = row.pool === 'solver' ? 'solver' : 'main';
        out[key] += 1;
        out.usable += 1;
      }
      return out;
    },
    /** 加入（已存在则只补全元数据），返回是否新增 */
    add(token, { source = null, deviceId = null, note = null, createdAt = null, pool = 'main' } = {}) {
      const value = String(token || '').trim();
      if (!value) throw new Error('token 不能为空');
      const existed = Boolean(selectOne.get(value));
      upsert.run(value, createdAt || new Date().toISOString(), source, deviceId, note, POOLS.includes(pool) ? pool : 'main');
      return !existed;
    },
    remove(token) {
      return del.run(String(token)).changes > 0;
    },
    /** 用给定列表「替换全部」（与后台的 replace 语义一致） */
    replaceAll(tokens, meta = {}) {
      const now = new Date().toISOString();
      for (const token of tokens) upsert.run(String(token), now, meta.source ?? null, meta.deviceId ?? null, meta.note ?? null);
      delOthers.run(JSON.stringify(tokens.map(String)));
      return tokens.length;
    },
    count() {
      return count.get().n;
    },
  };

  stores.set(dbFile, store);
  return store;
}

/** 从旧 auth.json 导入（只在库为空时调用） */
export function importFromAuthFile(store, authFile) {
  if (!store || !authFile) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    const list = [];
    if (Array.isArray(parsed.tokens)) list.push(...parsed.tokens);
    if (parsed.token) list.push(parsed.token);
    const unique = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
    const savedAt = parsed.savedAt || null;
    let added = 0;
    for (const token of unique) {
      if (store.add(token, { source: 'auth.json', createdAt: savedAt })) added += 1;
    }
    return added;
  } catch {
    return 0;
  }
}
