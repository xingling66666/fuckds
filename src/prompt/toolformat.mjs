/**
 * 工具调用格式分发层。
 *
 * 现状（2026-11）：
 *   - **只教一种格式**：`<____tool____>` XML（special.mjs 的 stealth 提示词）。
 *     DSML 不再出现在任何提示词里 —— 教两种格式只会让模型在两种语法之间漂。
 *   - **解析上仍然兼容 DSML**：历史上下文里可能残留旧的 DSML 块（老会话回放、
 *     客户端自带的历史），不认就会把整段上下文读成纯文本，模型跟着学坏。
 *
 * 所以规则是：
 *   解析  = XML 优先 + DSML 兜底（按出现位置合并、按 name+args 去重）
 *   剔除  = 两种块都剔（否则旧块会漏进 content）
 *   重建  = 一律 XML（保证模型看到的永远是同一种形状）
 */

import { parseDsmlCalls, findDsmlBlocks, findDsmlStart } from './dsml.mjs';
import { parseFenceCalls, parseBareFenceCalls, findFenceBlocks, findFenceStart, buildFenceBlock } from './fence.mjs';
import {
  parseToolXmlCalls,
  findToolXmlBlocks,
  findToolXmlStart,
  buildToolXmlBlock,
} from './toolxml.mjs';

export function parseToolCallsAny(text, allowed = null, { toolSchemas = null } = {}) {
  if (!text || typeof text !== 'string') return [];
  // toolSchemas 可能是 Map 也可能是普通对象
  const schemaObj = toolSchemas && typeof toolSchemas.get === 'function'
    ? Object.fromEntries(toolSchemas)
    : toolSchemas;
  // 有「执行」前缀的优先；没有的话再看裸代码块（nudge 模式模型就这么输出）
  const marked = parseFenceCalls(text, allowed, schemaObj);
  const fenceCalls = marked.length ? marked : parseBareFenceCalls(text, allowed, schemaObj);
  const xmlCalls = parseToolXmlCalls(text, allowed);
  const dsmlCalls = parseDsmlCalls(text, allowed);

  const merged = [...fenceCalls, ...xmlCalls, ...dsmlCalls].sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const call of merged) {
    const sig = `${call.name}\u0000${call.arguments}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(call);
  }
  return out;
}

export function findToolBlocksAny(text) {
  if (!text) return [];
  const fence = findFenceBlocks(text).map((b) => ({ start: b.index, end: b.index + b.length, raw: b.raw }));
  const blocks = [...fence, ...findToolXmlBlocks(text), ...findDsmlBlocks(text)];
  return blocks.sort((a, b) => a.start - b.start);
}

export function findToolStartAny(text, from = 0) {
  if (!text) return null;
  const candidates = [findFenceStart(text) ? from : null, findToolXmlStart(text, from), findDsmlStart(text, from)].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => a.index - b.index)[0];
}

/**
 * 上下文回写：**只用代码块格式**（和提示词一致）。
 *
 * 历史里只要出现 <plan>/<____tool____> 这类标签，模型就会照着模仿，
 * 旧协议的特征会一直留在对话里 —— 实测这正是被封的诱因之一。
 */
export function buildToolCallBlock(calls = [], schemas = null) {
  if (!Array.isArray(calls) || !calls.length) return '';
  return buildFenceBlock(calls, schemas);
}

/**
 * 兼容入口：给只想要「一套函数」的调用方。
 * 老代码里 `dsmlOnly` 的语义已失效 —— 现在永远是 XML 优先、DSML 兜底。
 */
export function makeToolFormat() {
  return {
    parse: parseToolCallsAny,
    blocks: findToolBlocksAny,
    start: findToolStartAny,
    buildBlock: buildToolCallBlock,
  };
}
