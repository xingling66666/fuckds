/**
 * 注入到页面里的工具函数（由 Playwright addInitScript 执行）。
 *
 * 注意：这个函数会被序列化后丢进浏览器，所以不能引用模块作用域里的任何东西。
 * 它负责两件事：
 *   1. 把渲染后的 Markdown DOM 还原成 Markdown 文本；
 *   2. 读取当前对话状态（回答 / 思考过程 / 是否正在生成 / 是否弹验证码）。
 */
export function installPageHelpers() {
  if (window.__DSW__) return;

  const SEL = {
    assistant: '.ds-assistant-message-main-content',
    markdown: '.ds-markdown',
    think: '.ds-think-content',
    input: 'textarea',
  };

  const INLINE_TRANSPARENT = new Set(['div', 'section', 'article', 'main', 'span', 'font', 'u', 'small']);
  const BLOCK_TAGS = new Set([
    'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre',
    'blockquote', 'table', 'thead', 'tbody', 'tr', 'hr', 'div', 'section', 'article', 'main',
  ]);

  const collapse = (text) => {
    // 代码块里的空白要原样保留，只对非代码段做压缩
    return text
      .split(/(```[\s\S]*?```)/)
      .map((part, index) => {
        if (index % 2 === 1) return part;
        return part.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
      })
      .join('')
      .trim();
  };

  const isVisible = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };

  const hasClass = (el, needle) => (el.getAttribute('class') || '').includes(needle);

  function katexSource(el) {
    const annotation = el.querySelector('annotation[encoding="application/x-tex"]');
    if (annotation && annotation.textContent) return annotation.textContent;
    const math = el.querySelector('[data-latex]');
    if (math) return math.getAttribute('data-latex');
    return null;
  }

  /** DeepSeek 的代码块外层是 .md-code-block，语言名在 banner 里、按钮也在 banner 里 */
  function serializeCodeBlock(wrapper) {
    const pre = wrapper.querySelector('pre');
    if (!pre) return null;

    let lang = '';
    const banner =
      wrapper.querySelector('[class*="banner-wrap"]') ||
      wrapper.querySelector('[class*="banner"]') ||
      wrapper.querySelector('[class*="header"]');
    if (banner) {
      const clone = banner.cloneNode(true);
      clone
        .querySelectorAll('button, [role="button"], [class*="button"], [class*="copy"], [class*="download"], svg')
        .forEach((el) => el.remove());
      const text = (clone.textContent || '').trim();
      const match = text.match(/^[A-Za-z0-9+#._-]{1,20}$/);
      if (match) lang = match[0];
    }

    if (!lang) {
      const codeEl = pre.querySelector('code');
      const classText = `${(codeEl && codeEl.getAttribute('class')) || ''} ${pre.getAttribute('class') || ''}`;
      const m = classText.match(/(?:language|lang)-([\w+#.-]+)/i);
      if (m) lang = m[1];
    }

    const codeEl = pre.querySelector('code') || pre;
    const code = (codeEl.textContent || '').replace(/\n+$/, '');
    return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
  }

  function serializeList(list, ctx) {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const start = Number.parseInt(list.getAttribute('start') || '1', 10) || 1;
    const items = Array.from(list.children).filter((c) => c.tagName && c.tagName.toLowerCase() === 'li');
    const lines = [];
    items.forEach((li, i) => {
      const marker = ordered ? `${start + i}. ` : '- ';
      const indent = '  '.repeat(ctx.listDepth);
      const body = serializeChildren(li, { ...ctx, listDepth: ctx.listDepth + 1 }).trim();
      const pad = ' '.repeat(marker.length);
      const text = body
        .split('\n')
        .map((line, idx) => (idx === 0 ? line : line ? pad + line : ''))
        .join('\n');
      lines.push(`${indent}${marker}${text}`);
    });
    return `\n${lines.join('\n')}\n\n`;
  }

  function serializeTable(table, ctx) {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return '';

    let grid = rows
      .map((tr) =>
        Array.from(tr.children)
          .filter((c) => c.tagName && /^(td|th)$/i.test(c.tagName))
          .map((cell) =>
            serializeChildren(cell, ctx)
              .replace(/\n+/g, ' ')
              .replace(/\|/g, '\\|')
              .trim(),
          ),
      )
      .filter((row) => row.length > 0);

    if (!grid.length) return '';

    const width = Math.max(...grid.map((row) => row.length));
    const pad = (row) => {
      const copy = row.slice();
      while (copy.length < width) copy.push('');
      return copy;
    };

    const header = pad(grid[0]);
    const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
    for (const row of grid.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
    return lines.join('\n');
  }

  function serializeChildren(node, ctx) {
    const children = Array.from(node.childNodes);
    // 块级元素之间的排版空白（HTML 源码缩进）不该变成正文里的空格
    const hasBlockChild = children.some(
      (child) => child.nodeType === 1 && BLOCK_TAGS.has((child.tagName || '').toLowerCase()),
    );
    return children
      .map((child) => {
        if (hasBlockChild && child.nodeType === 3 && !(child.nodeValue || '').trim()) return '';
        return serializeNode(child, ctx);
      })
      .join('');
  }

  function serializeNode(node, ctx) {
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      return ctx.inPre ? value : value.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || '').toLowerCase();
    const kids = (nextCtx) => serializeChildren(node, nextCtx || ctx);

    // 代码块整体处理，避免 banner 上的「python 复制 下载」混进正文
    if (node.classList && node.classList.contains('md-code-block')) {
      const block = serializeCodeBlock(node);
      if (block !== null) return block;
    }

    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return '\n\n---\n\n';
      case 'h1':
        return `# ${kids().trim()}\n\n`;
      case 'h2':
        return `## ${kids().trim()}\n\n`;
      case 'h3':
        return `### ${kids().trim()}\n\n`;
      case 'h4':
        return `#### ${kids().trim()}\n\n`;
      case 'h5':
        return `##### ${kids().trim()}\n\n`;
      case 'h6':
        return `###### ${kids().trim()}\n\n`;
      case 'p':
        return `${kids().trim()}\n\n`;
      case 'strong':
      case 'b': {
        const text = kids().trim();
        if (!text) return '';
        return isTrailingInline(node, ctx) ? `**${text}` : `**${text}**`;
      }
      case 'em':
      case 'i': {
        const text = kids().trim();
        if (!text) return '';
        return isTrailingInline(node, ctx) ? `*${text}` : `*${text}*`;
      }
      case 'del':
      case 's': {
        const text = kids().trim();
        return isTrailingInline(node, ctx) ? `~~${text}` : `~~${text}~~`;
      }
      case 'mark':
        return `==${kids().trim()}==`;
      case 'sup':
        return `^${kids().trim()}^`;
      case 'sub':
        return `~${kids().trim()}~`;
      case 'a': {
        const href = node.getAttribute('href') || '';
        const text = kids().trim();
        if (!href || href.startsWith('javascript:')) return text;
        return isTrailingInline(node, ctx) ? `[${text}` : `[${text}](${href})`;
      }
      case 'img': {
        const alt = node.getAttribute('alt') || '';
        const src = node.getAttribute('src') || '';
        return src ? `![${alt}](${src})` : alt;
      }
      case 'blockquote': {
        const body = kids().trim();
        if (!body) return '';
        return `${body
          .split('\n')
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n')}\n\n`;
      }
      case 'ul':
      case 'ol':
        return serializeList(node, ctx);
      case 'li':
        return kids();
      case 'table': {
        // 表格单元格是逐字填充的，流式阶段先不输出，等它不再是最后一块时整体补上
        if (ctx.streaming && ctx.root && !hasTextAfter(node, ctx.root)) return '';
        return `${serializeTable(node, ctx)}\n\n`;
      }
      case 'thead':
      case 'tbody':
      case 'tfoot':
      case 'tr':
      case 'td':
      case 'th':
        return kids();
      case 'pre': {
        const clone = node.cloneNode(true);
        clone
          .querySelectorAll('button, [class*="copy" i], [class*="toolbar" i], [class*="header" i]')
          .forEach((el) => el.remove());
        const codeEl = clone.querySelector('code') || clone;
        const classText = `${codeEl.getAttribute('class') || ''} ${node.getAttribute('class') || ''}`;
        const langMatch = classText.match(/(?:language|lang)-([\w+#.-]+)/i);
        const lang = langMatch ? langMatch[1] : '';
        const code = (codeEl.textContent || '').replace(/\n+$/, '');
        return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
      }
      case 'code': {
        if (ctx.inPre) return kids();
        const text = (node.textContent || '').trim();
        if (!text) return '';
        return isTrailingInline(node, ctx) ? `\`${text}` : `\`${text}\``;
      }
      case 'katex':
      case 'math': {
        const tex = katexSource(node);
        return tex ? `$${tex}$` : kids().trim();
      }
      case 'script':
      case 'style':
      case 'svg':
      case 'button':
      case 'noscript':
        return '';
      default:
        if (node.classList && node.classList.contains('katex')) {
          const tex = katexSource(node);
          if (tex) return `$${tex}$`;
        }
        if (node.classList && node.classList.contains('ds-markdown-math')) {
          const tex = katexSource(node);
          if (tex) return `$${tex}$`;
        }
        if (INLINE_TRANSPARENT.has(tag)) return kids();
        return kids();
    }
  }

  /**
   * 流式序列化：正在生成的代码块还没写完，不能每次都给一个收尾 ```，
   * 否则下一次轮询文本又变长，前缀对不上，增量就断了。
   */
  function hasTextAfter(node, root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let seen = false;
    let current;
    while ((current = walker.nextNode())) {
      if (node.contains(current)) {
        seen = true;
        continue;
      }
      if (seen && (current.nodeValue || '').trim()) return true;
    }
    return false;
  }

  /** 流式时，最后一个还在变长的内联元素不要提前补闭合符号 */
  function isTrailingInline(node, ctx) {
    return Boolean(ctx.streaming && ctx.root && !hasTextAfter(node, ctx.root));
  }

  function stripTrailingCodeFence(root, text) {
    const pres = root.querySelectorAll('pre');
    const last = pres[pres.length - 1];
    if (!last || hasTextAfter(last, root)) return text;
    const trimmed = text.replace(/\s+$/, '');
    if (!trimmed.endsWith('```')) return text;
    return trimmed.slice(0, -3).replace(/\s+$/, '');
  }

  function serialize(root, options) {
    if (!root) return '';
    const streaming = Boolean(options && options.streaming);
    const text = collapse(serializeNode(root, { listDepth: 0, inPre: false, streaming, root }));
    return streaming ? stripTrailingCodeFence(root, text) : text;
  }

  // 发送按钮在「生成中」会换成停止图标（圆角方框），用 path 前缀识别最稳
  const STOP_ICON_PREFIX = 'M2 4.88';

  function composerRoot() {
    const input = document.querySelector(SEL.input);
    if (!input) return null;
    let el = input.parentElement;
    for (let i = 0; i < 6 && el; i += 1, el = el.parentElement) {
      if (el.querySelector('.ds-button--primary.ds-button--circle')) return el;
    }
    return null;
  }

  function sendButton() {
    const root = composerRoot() || document;
    return root.querySelector('.ds-button--primary.ds-button--circle');
  }

  function looksLikeStop(label) {
    return /停止生成|停止|stop generating|^stop$/i.test(String(label || '').trim());
  }

  function detectGenerating() {
    // 1) 主路径：发送按钮的图标变成停止方框
    const btn = sendButton();
    if (btn) {
      const paths = Array.from(btn.querySelectorAll('svg path'));
      if (paths.some((path) => (path.getAttribute('d') || '').trim().startsWith(STOP_ICON_PREFIX))) {
        return true;
      }
    }

    // 2) 兜底：按钮上的无障碍文案
    const candidates = document.querySelectorAll('button, [role="button"], [aria-label]');
    for (const el of candidates) {
      const label = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`.trim();
      if (label && looksLikeStop(label) && isVisible(el)) return true;
    }
    return false;
  }

  /** 读「深度思考 / 智能搜索」开关状态 */
  function toggleState(label) {
    const buttons = document.querySelectorAll('.ds-toggle-button');
    for (const el of buttons) {
      if (!(el.innerText || '').includes(label)) continue;
      return {
        found: true,
        selected: el.classList.contains('ds-toggle-button--selected'),
        visible: isVisible(el),
      };
    }
    return { found: false, selected: false, visible: false };
  }

  function clickToggle(label) {
    const buttons = document.querySelectorAll('.ds-toggle-button');
    for (const el of buttons) {
      if ((el.innerText || '').includes(label) && isVisible(el)) {
        el.click();
        return true;
      }
    }
    return false;
  }

  function bodyText() {
    return document.body ? document.body.innerText || '' : '';
  }

  function detectCaptcha() {
    if (document.querySelector('.ds-shumei-captcha-error__message')) return true;
    if (document.querySelector('[class*="shumei" i] [class*="captcha" i]')) {
      return true;
    }
    const text = bodyText();
    return /人机验证|请完成验证|请先完成下方验证|拖动滑块|verify you are human/i.test(text);
  }

  function detectNotice() {
    const nodes = document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="notification" i]');
    for (const node of nodes) {
      const text = (node.innerText || '').trim();
      if (text) return text.slice(0, 300);
    }
    return '';
  }

  function extract(options) {
    const streaming = Boolean(options && options.streaming);
    const out = {
      url: location.href,
      signedIn: !/\/sign_in/.test(location.pathname),
      assistantCount: 0,
      hasAnswer: false,
      hasThink: false,
      answer: '',
      thinking: '',
      generating: false,
      captcha: false,
      rateLimited: false,
      notice: '',
      inputVisible: false,
      inputValue: '',
      stopVisible: false,
      answerComplete: false,
    };

    const input = document.querySelector(SEL.input);
    if (input) {
      out.inputVisible = isVisible(input) || input.offsetParent !== null;
      out.inputValue = input.value || '';
    }

    const blocks = document.querySelectorAll(SEL.assistant);
    out.assistantCount = blocks.length;
    const last = blocks[blocks.length - 1];

    if (last) {
      // 思考块不在回答容器里，而在同一条消息的外层（virtual-list item）里
      const item = last.closest('[data-virtual-list-item-key]') || last.parentElement;
      let think = last.querySelector(SEL.think) || (item && item.querySelector(SEL.think));
      if (!think) {
        const all = document.querySelectorAll(SEL.think);
        think = all.length ? all[all.length - 1] : null;
      }
      out.hasThink = Boolean(think);
      if (think) {
        const thinkMd =
          think.matches && think.matches(SEL.markdown) ? think : think.querySelector(SEL.markdown) || think;
        out.thinking = serialize(thinkMd, { streaming });
      }

      // 真实页面里回答容器本身就是 .ds-markdown（class="ds-markdown ds-assistant-message-main-content"），
      // querySelectorAll 只查子孙节点会漏掉它，所以要单独判断自己。
      const nodes = [];
      if (last.matches && last.matches(SEL.markdown)) nodes.push(last);
      nodes.push(...Array.from(last.querySelectorAll(SEL.markdown)));

      const inThink = (el) => Boolean(think) && (el === think || think.contains(el));
      const answerEl = nodes.filter((el) => !inThink(el)).pop();
      if (answerEl) {
        out.answer = serialize(answerEl, { streaming });
        out.hasAnswer = Boolean(out.answer);
        // 生成长按/朗读/复制这些操作按钮只在回答结束后出现
        const actions = (last.closest('[data-virtual-list-item-key]') || last).querySelectorAll(
          '[aria-label="朗读"], [aria-label="重新生成"]',
        );
        out.answerComplete = actions.length > 0;
      }
    }

    out.stopVisible = detectGenerating();
    out.generating = out.stopVisible;
    out.captcha = detectCaptcha();
    out.rateLimited = /(发送|请求|操作)过于频繁|连续访问次数过多/.test(bodyText());
    out.notice = detectNotice();

    return out;
  }

  function clickByTexts(labels) {
    const wanted = labels.map((label) => label.trim());
    const nodes = document.querySelectorAll(
      'button, a, [role="button"], [role="menuitem"], [class*="button"], div, span',
    );

    for (const label of wanted) {
      const matches = [];
      for (const el of nodes) {
        const text = (el.innerText || '').trim();
        const aria = (el.getAttribute('aria-label') || '').trim();
        if (text !== label && aria !== label) continue;
        if (!isVisible(el)) continue;
        matches.push(el);
      }
      if (!matches.length) continue;

      // 取面积最小的那个（最内层文本节点），点击会冒泡到真正的按钮容器
      matches.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return ra.width * ra.height - rb.width * rb.height;
      });
      matches[0].click();
      return true;
    }
    return false;
  }

  function focusInput() {
    const input = document.querySelector(SEL.input);
    if (!input) return false;
    input.focus();
    return document.activeElement === input;
  }

  function inputState() {
    const input = document.querySelector(SEL.input);
    return input ? { value: input.value, focused: document.activeElement === input } : null;
  }

  window.__DSW__ = {
    version: 1,
    selectors: SEL,
    serialize,
    extract,
    clickByTexts,
    focusInput,
    inputState,
    detectGenerating,
    detectCaptcha,
    toggleState,
    clickToggle,
  };
}
