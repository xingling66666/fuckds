/**
 * `<ds_think>...</ds_think>` → 思考内容（reasoning）映射。
 *
 * 关掉 DeepSeek 原生「深度思考」后，模型可以把内部推理直接写进正文：
 *
 *   <ds_think>先确认用户想要什么，再决定怎么回答。</ds_think>
 *   你好！
 *
 * 服务端把标签里的内容抽出来当作 reasoning_content / thinking 块，
 * 标签本身和里面的内容都不会出现在 content 里。
 *
 * 兼容两种写法：`<ds_think>`（大小写不敏感）和没闭合的 `<ds_think>`（输出被截断 / 流式还没吐完时，
 * 从标签开始到结尾都算思考内容）。
 */

const OPEN_TAG = /<think(?:\s[^>]*)?>/i;
const CLOSE_TAG = /<\/think\s*>/i;

/** 流式时可能被 chunk 边界切开的标签前缀（`<thi`、`</thi` 之类） */
const PARTIAL_OPEN = /^<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i;
const PARTIAL_CLOSE = /^<\/(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/i;

/**
 * 从一段完整正文里抽出思考内容。
 * @param {string} text
 * @returns {{ content: string, reasoning: string }}
 */
export function extractThinkBlocks(text) {
  if (!text || typeof text !== 'string') return { content: '', reasoning: '' };

  let content = '';
  let reasoning = '';
  let rest = text;

  for (;;) {
    const open = OPEN_TAG.exec(rest);
    if (!open) {
      content += rest;
      break;
    }
    content += rest.slice(0, open.index);
    rest = rest.slice(open.index + open[0].length);

    const close = CLOSE_TAG.exec(rest);
    if (!close) {
      // 没闭合：剩下的都算思考内容
      reasoning += rest;
      break;
    }
    reasoning += rest.slice(0, close.index);
    rest = rest.slice(close.index + close[0].length);
  }

  return { content: content.trim(), reasoning: reasoning.trim() };
}

/**
 * 流式 `<ds_think>` 过滤器：正文照常流出，标签内的文本改走 reasoning。
 *
 *   const f = new ThinkTagStreamFilter();
 *   f.push('<thi')  -> { content: '', reasoning: '' }        // 半截标签先扣住
 *   f.push('nk>想')  -> { content: '', reasoning: '想' }
 *   f.push('一下</ds_think>好') -> { content: '好', reasoning: '一下' }
 *   f.flush()       -> 剩余内容
 */
export class ThinkTagStreamFilter {
  constructor() {
    this.buffer = '';
    this.mode = 'content'; // content | reasoning
  }

  push(text) {
    if (text) this.buffer += text;
    return this.#drain(false);
  }

  flush() {
    return this.#drain(true);
  }

  #drain(final) {
    let content = '';
    let reasoning = '';

    for (;;) {
      if (this.mode === 'content') {
        const lower = this.buffer.toLowerCase();
        const at = lower.indexOf('<think');
        if (at === -1) {
          if (final) {
            content += this.buffer;
            this.buffer = '';
          } else {
            content += this.#takeSafeContent();
          }
          break;
        }
        if (at > 0) {
          content += this.buffer.slice(0, at);
          this.buffer = this.buffer.slice(at);
          continue;
        }
        const open = OPEN_TAG.exec(this.buffer);
        if (!open) {
          if (final) {
            // 到结尾还是半截标签：当普通正文
            content += this.buffer;
            this.buffer = '';
          }
          break;
        }
        this.buffer = this.buffer.slice(open[0].length);
        this.mode = 'reasoning';
        continue;
      }

      // reasoning：找 </ds_think>
      const lower = this.buffer.toLowerCase();
      const at = lower.indexOf('</think');
      if (at === -1) {
        if (final) {
          reasoning += this.buffer;
          this.buffer = '';
        } else {
          reasoning += this.#takeSafeReasoning();
        }
        break;
      }
      if (at > 0) {
        reasoning += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at);
        continue;
      }
      const close = CLOSE_TAG.exec(this.buffer);
      if (!close) {
        if (final) {
          reasoning += this.buffer;
          this.buffer = '';
        }
        break;
      }
      this.buffer = this.buffer.slice(close[0].length);
      this.mode = 'content';
    }

    return { content, reasoning };
  }

  /** 正文模式：没找到 `<think`，但要扣住尾部可能是半截标签的字符 */
  #takeSafeContent() {
    const keep = this.#partialTail(PARTIAL_OPEN);
    const out = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    return out;
  }

  /** 思考模式：没找到 `</think`，扣住尾部可能是半截关闭标签的字符 */
  #takeSafeReasoning() {
    const keep = this.#partialTail(PARTIAL_CLOSE);
    const out = this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    return out;
  }

  #partialTail(pattern) {
    for (let len = Math.min(this.buffer.length, 8); len > 0; len -= 1) {
      const tail = this.buffer.slice(-len);
      if (tail.startsWith('<') && pattern.test(tail)) return len;
    }
    return 0;
  }
}
