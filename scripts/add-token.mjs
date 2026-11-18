import { loadConfig } from '../src/config.mjs';
import { openTokenStore } from '../src/token-store.mjs';

const raw = process.argv[2];
if (!raw) { console.error('用法: node scripts/add-token.mjs <userToken 或 localStorage JSON>'); process.exit(1); }
let tok = raw.trim();
try {
  const j = JSON.parse(tok);
  if (j && typeof j.value === 'string') tok = j.value;
} catch {}
const config = loadConfig(process.env, {});
const store = openTokenStore({ dataDir: config.dataDir });
const ok = store.add(tok, { source: 'manual-yg', note: 'from chat' });
console.log('added:', ok, '| pool size:', store.list ? store.list().length : '?');
console.log('token head:', tok.slice(0, 8) + '…', 'len', tok.length);
