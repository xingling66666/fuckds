import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「模型输出原文」缓存。
 *
 * 背景：把工具调用解析成标准 tool_calls 返回给客户端时，正文里那段密文块会被剥掉。
 * 客户端下一轮把 assistant 消息发回来时 `content` 往往是空字符串，只带 tool_calls
 * —— 于是拼上下文时模型输出的原文就丢了，agent 看到的历史里凭空少了自己说过的话。
 *
 * 这里记住「那一次调用对应的模型原始输出」，拼上下文时回填。两条索引：
 *   1) call.id（正常情况，客户端会原样带回）
 *   2) name + arguments 签名（客户端换了 id / 自己生成了 id 时的兜底）
 *
 * 落盘到 data/tool-text.json，**进程重启不丢**（之前只在内存里，重启就把历史清空了）。
 */
const MAX_ENTRIES = 800;
let store = new Map();
let loaded = false;
let filePath = '';

const signatureOf = (name, args) =>
  crypto
    .createHash('sha1')
    .update(`${String(name || '').trim()}\u0000${String(args || '').trim()}`)
    .digest('hex')
    .slice(0, 16);

function ensureLoaded(dataDir) {
  if (!dataDir) return;
  const next = path.join(dataDir, 'tool-text.json');
  if (loaded && next === filePath) return;
  filePath = next;
  loaded = true;
  store = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(raw || {})) store.set(key, value);
  } catch {
    /* 没有就空着 */
  }
}

function persist() {
  if (!filePath) return;
  try {
    const obj = Object.fromEntries(store);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
  } catch {
    /* 写不了就只留在内存 */
  }
}

const put = (key, value) => {
  if (!key || !value) return;
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(String(key), value);
};

/**
 * 记下一轮输出原文。
 * @param {Array<{id?:string,name?:string,arguments?:string}>|string[]} calls 这次的调用（或它们的 id）
 * @param {string} text 模型原始输出
 * @param {string} [dataDir] 传入则落盘
 */
export function rememberRawText(calls, text, dataDir) {
  const raw = String(text || '').trim();
  if (!raw || !Array.isArray(calls) || !calls.length) return;
  ensureLoaded(dataDir);
  for (const call of calls) {
    if (typeof call === 'string') {
      put(call, { text: raw });
      continue;
    }
    const entry = { text: raw, name: call?.name || '', args: call?.arguments || '' };
    if (call?.id) put(call.id, entry);
    if (call?.name) put(`sig:${signatureOf(call.name, call.arguments)}`, entry);
  }
  persist();
}

/** 取出某个 tool_call 对应的原文（先按 id，再按签名） */
export function lookupRawText(call) {
  if (!call) return '';
  if (typeof call === 'string') return store.get(call)?.text || '';
  if (call.id) {
    const hit = store.get(call.id);
    if (hit?.text) return hit.text;
  }
  if (call?.function?.name) {
    const hit = store.get(`sig:${signatureOf(call.function.name, call.function.arguments)}`);
    if (hit?.text) return hit.text;
  }
  return '';
}

/**
 * 回填：assistant 正文为空、但有 tool_calls 时，用缓存里的原文补上。
 * 客户端自己带了正文的，优先信客户端的。
 */
export function hydrateAssistantText(messages = [], dataDir) {
  if (!Array.isArray(messages)) return messages;
  ensureLoaded(dataDir);
  return messages.map((message) => {
    if (message?.role !== 'assistant') return message;
    const hasContent =
      typeof message.content === 'string' ? message.content.trim() : Boolean(message.content);
    if (hasContent) return message;
    const calls = message.tool_calls || [];
    if (!calls.length) return message;
    for (const call of calls) {
      const raw = lookupRawText(call);
      if (raw) return { ...message, content: raw };
    }
    return message;
  });
}

/** 测试用 */
/** 测试用：直接看缓存里有多少条 */
