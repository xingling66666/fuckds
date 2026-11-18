import { PromptTooLongError } from './errors.mjs';
import { loadImage } from './openai/images.mjs';
import {
  findToolMarkup,
  hasFabricatedProtocol,
  reconcileStreamedText,
  stripToolMarkup,
  ToolMarkupStreamFilter,
} from './openai/tool-text.mjs';
import { extractThinkBlocks, ThinkTagStreamFilter } from './openai/think-tags.mjs';
import crypto from 'node:crypto';

import { buildPrompt } from './prompt/build.mjs';
import { attachmentHint } from './prompt/special.mjs';
import { planOverflow } from './prompt/overflow.mjs';
import { coerceToolCallArguments, getToolSchemas, parseToolCalls } from './prompt/tools.mjs';
import { hydrateAssistantText, rememberRawText } from './tool-text-cache.mjs';

/**
 * 引擎调用的公共部分：拼 prompt → 图片/超长附件上传 → 调 web.chat → 解析工具调用。
 *
 * OpenAI 和 Anthropic 两个协议层只负责请求归一化和响应格式，执行逻辑都在这里，
 * 保证两条链路在「防自造结果」「超长转附件」上的行为完全一致。
 */
export function createChatRunner({ config, log, web }) {
  /**
   * @param {object} request 归一化后的内部请求（messages 为 OpenAI 语义）
   * @param {object} [hooks]
   * @param {AbortSignal} [hooks.signal]
   * @param {object} [hooks.meta] 透传给 web.chat 的元信息（请求 id 等）
   * @param {(prompt: string, info: object) => void} [hooks.onPrompt] prompt 拼好后、真正发送前回调
   * @param {(text: string) => void} [hooks.onContent] 流式正文增量（已过滤协议行）
   * @param {(text: string) => void} [hooks.onReasoning] 流式思考增量
   */
  return async function runChat(request, { signal, meta = {}, onPrompt, onContent, onReasoning } = {}) {
    /**
     * 会话身份 + 增量 prompt 构造器。
     *
     * 为什么需要：旧实现**每条消息都 chat_session/create 一个新会话** ——
     * 真人 1 个会话发 N 条，这里是 N 个会话各 1 条，创建会话的速率是极强的机器人指纹。
     *
     * 现在改成「真会话续聊」：
     *   - key 由「system + 工具名 + 第一条 user 消息」决定 → 同一段对话始终是同一个 key；
     *   - 引擎自己记着这个会话里已经发到第几条消息（consumedCount）；
     *   - 续聊时只把**新增的那几条**拼成 prompt 发出去（服务端会话里已经有前面的历史），
     *     这正是网页端的行为：prompt 只放新输入，parent_message_id 指向上一条回复。
     */
    const conversationKey = (() => {
      const hint = meta?.conversationHint || request?.conversation_id || request?.metadata?.conversation_id || null;
      const firstUser = (request.messages || []).find((m) => m?.role === 'user');
      // 注意：**不要把 system 文本也算进 key**。
      // agent 的 system 经常带时间戳/工具列表等易变内容，一变更 key 就换会话 → 每轮全量。
      // 第一条 user 消息 + 来源提示（IP / X-Conversation-Id）足以定位「这是不是同一段对话」。
      // 关键：material 里必须带**调用方标识**（hint 已经是 caller:<keyhash>:ip:<ip>）。
      // 否则两个用户都以「你好」开头时 key 相同 → 复用同一个上游会话 → 上下文串号。
      const material = `${hint ? String(hint) : 'anon'}\u0000${JSON.stringify(firstUser || null)}`;
      // 有显式会话提示（头 X-Conversation-Id / 字段 conversation_id / 来源 IP）就以它为主：
      // 多人共用同一个服务时，这是唯一能保证「不会把 A 的对话续成 B 的」的办法。
      return crypto.createHash('sha1').update(material).digest('hex');
    })();

    /** 拼「只含第 from 条之后的消息」的增量 prompt（工具与协议声明仍带上，体积很小） */
    const buildDelta = (from, systemExtra = '') => {
      /** 增量只发「还没进过会话的对话」：
       *  服务端会话里已经有 assistant 的回复了，再发一遍会被当成重复输入，
       *  实测会导致第二次续聊返回空。所以跳过开头的 assistant/tool，从第一条 user 起。
       */
      const tail = (request.messages || []).slice(from);
      const firstUserIdx = tail.findIndex((m) => m?.role === 'user');
      const sliced = firstUserIdx > 0 ? tail.slice(firstUserIdx) : tail;
      const built = buildPrompt({
        messages: hydrateAssistantText(sliced.length ? sliced : request.messages, config.dataDir),
        tools: request.tools,
        systemExtra,
        // 续聊只发**新增的消息段落**：header / system / 工具声明 / 协议提示词
        // 第一轮已经进过这个会话了，由服务端会话保留；再造一遍等于把全量又发一次。
        toolDeclMode: 'compact',
        sectionsOnly: true,
        promptStyle,
        protocolMode,
      });
      // buildPrompt 现在返回 { prompt, stats, ... }，续聊只需要字符串
      return typeof built === 'string' ? built : built?.prompt || '';
    };

    const {
      maxPromptChars,
      maxAttachmentChars,
      overflowToAttachment,
      toolDeclMode = 'auto',
      /**
       * 工具数超过这个值就强制用压缩索引（默认 40）。
       *
       * 为什么这是风控问题而不是性能问题：agent 动辄带上百个工具，
       * 完整 JSON 声明能到 100KB+，而真人网页版从不会出现这种请求。
       * 日志里 324 个工具 + 19 万字符的 prompt 反复出现，token 随后就被吊销 ——
       * 服务端看到的不是「一个人在用网页」，而是「一台机器在灌 prompt」。
       */
      toolDeclCompactThreshold = 40,
      /**
       * 提示词风格：stealth（默认，中性词，不出现 tool/工具 字样）| legacy（直白写法）
       */
      promptStyle = 'stealth',
      protocolMode = 'nudge',
    } = config.runtime;

    /**
     * 拼 prompt；超过输入框上限时把较早的段落拆成附件。
     *
     * auto 模式下：完整工具声明放得下就用完整；一旦需要拆分，就改用压缩索引重建。
     * 否则上百个工具的完整声明（可能上百 KB）会把正文挤干，模型等于看不到对话。
     */
    /**
     * 本次请求实际使用的 systemExtra。
     * prepare() 是局部作用域，但续聊的 buildDelta 回调要在它外面用同一个值 ——
     * 之前闭包直接引用 prepare 的参数，导致 `systemExtra is not defined`。
     */
    let activeSystemExtra = '';

    /** 正文全部走附件（输入框只放引导），见 config.runtime.promptAsAttachment */
    const promptAsAttachment = config.runtime.promptAsAttachment === true; // 缺省关闭：直接发

    const prepare = (systemExtra = '') => {
      activeSystemExtra = systemExtra;
      const toolCount = Array.isArray(request.tools) ? request.tools.length : 0;
      // 工具太多直接压缩，别再等「放不下」才压缩（放得下也得压，这是风控红线）
      const mode =
        toolDeclMode === 'full' && toolCount > toolDeclCompactThreshold
          ? 'compact'
          : toolDeclMode === 'auto' && toolCount > toolDeclCompactThreshold
            ? 'compact'
            : toolDeclMode;
      const build = (declMode) =>
        buildPrompt({
          messages: hydrateAssistantText(request.messages, config.dataDir),
          tools: request.tools,
          systemExtra,
          toolDeclMode: declMode,
          promptStyle,
          protocolMode,
        });

      let built = build(mode === 'compact' ? 'compact' : 'full');
      // 整包进附件时不需要"超长才拆"的判断：正文原样交给附件通道
      if (promptAsAttachment) return { built, prompt: built.prompt, attachment: null };
      if (!overflowToAttachment) return { built, prompt: built.prompt, attachment: null };

      // 完整声明就已经放得下：直接用，不做任何压缩
      if (mode !== 'compact' && built.prompt.length <= maxPromptChars) {
        return { built, prompt: built.prompt, attachment: null };
      }

      // auto：需要拆分时改压缩索引，把正文空间腾给对话
      if (mode === 'auto') {
        built = build('compact');
        if (built.prompt.length <= maxPromptChars) {
          return { built, prompt: built.prompt, attachment: null };
        }
      }

      const plan = planOverflow(built.prompt, { maxChars: maxPromptChars, maxAttachmentChars });
      return { built, prompt: plan.prompt, attachment: plan.attachment };
    };

    const initial = prepare();
    const { toolNames, stats } = initial.built;
    const prompt = initial.prompt;

    // 图片：下载/解码 → 传成 DeepSeek 附件 → ref_file_ids
    const imageIds = [];
    if (request.images?.length) {
      const loaded = await Promise.all(request.images.map((image) => loadImage(image.url)));
      imageIds.push(...(await web.uploadImages(loaded)));
      log?.info?.('已上传图片', { count: imageIds.length });
    }

    const uploadAttachment = async (plan) => {
      if (!plan.attachment) return [];
      if (typeof web.uploadAttachments !== 'function') {
        throw new PromptTooLongError('当前引擎不支持附件上传，无法承载超长上下文');
      }
      const ids = await web.uploadAttachments([plan.attachment]);
      log?.info?.('上下文超长，较早内容已转为附件', {
        name: plan.attachment.name,
        chars: plan.attachment.chars,
        sections: plan.attachment.sections,
        // 工具声明被挪进附件时模型会丢格式约定，必须能从日志看出来
        moved: plan.attachment.moved,
      });
      return ids;
    };

    /**
     * 正文整包进附件，输入框只放一句引导。
     *
     * 上传失败（例如回退到 browser 引擎，它不支持附件）就退回"把 prompt 直接填进输入框"，
     * 不能让请求挂掉 —— 附件只是降特征的通道，不是唯一通道。
     */
    let sendPrompt = prompt;
    let contextFile = initial.attachment;
    let contextIds = [];
    if (promptAsAttachment) {
      /**
       * 正文整包作为 .txt 附件上传，输入框只放一句引导。
       *
       * 附件里几千上万字符很正常；输入框一下塞满字符才容易触发风控。
       * （试过把正文渲染成图片走视觉通道 —— 模型要识图，整体明显更慢，已回退。）
       */
      try {
        const buffer = Buffer.from(prompt, 'utf8');
        const name = `context-${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8)}.txt`;
        const file = { name, mime: 'text/plain', buffer, chars: prompt.length, sections: stats.sections };
        const ids = await web.uploadAttachments([file]);
        if (ids?.length) {
          contextIds = ids;
          contextFile = file;
          sendPrompt = attachmentHint();
          log?.info?.('上下文已整体转为附件，输入框只放引导', {
            name,
            chars: file.chars,
            sections: file.sections,
          });
        }
      } catch (err) {
        log?.warn?.('正文转附件失败，退回直接把内容填进输入框:', err.message);
      }
    }

    const fileIds = [...imageIds, ...contextIds, ...(await uploadAttachment(initial))];
    onPrompt?.(sendPrompt, { stats, attachment: contextFile });

    const knownTools = toolNames.length ? toolNames : null;
    const knownToolSet = knownTools ? new Set(knownTools) : null;
    // 工具声明的 schema：原来 evaluate 只知道工具名，参数类型错了也原样
    // 发给客户端。现在按声明纠正一次可还原的类型错误（见 tools.mjs）。
    const toolSchemas = getToolSchemas(request.tools);
    const finalizeToolCalls = (calls) =>
      calls.map((call) => {
        const { arguments: coerced, warnings } = coerceToolCallArguments(call, toolSchemas);
        if (warnings.length) {
          log?.warn('工具调用参数与声明不符（已纠正可还原的部分，缺失值未编造）', {
            name: call.name,
            warnings,
          });
        }
        return coerced === call.arguments ? call : { ...call, arguments: coerced };
      });

    /**
     * 把一段原始输出整理成协议无关的语义：有效工具调用 + 干净正文。
     *
     * 模型输出的工具调用走 DSML（唯一协议），解析层转成标准 tool_calls；
     * 旧格式（<tool_call> / 原生 token / 旧版 DO）只做静默兜底，不再记日志；DSML 已不识别。
     */
    const evaluate = (text) => {
      const parsed = parseToolCalls(text, knownTools, { toolSchemas });
      // 不再做「重复调用抑制」：agent 里同一个调用原样重发是正常操作（每一步之后重新 observe_screen），
      // 按签名去重会把整轮输出吞成空回答。
      // 但参数要按声明纠正一次：模型常把数字/布尔/数组写成字符串，见 tools.mjs。
      const toolCalls = finalizeToolCalls(parsed);
      const content = stripToolMarkup(text, knownTools);

      // 诊断（只记日志，不改行为）：这一轮既没有正文、也没有工具调用时，客户端收到的是一条
      // 空 assistant 消息，agent 那边会直接判「模型未返回正文或工具调用」把整轮 loop 判失败。
      // 两种成因（协议块解析不出 / 工具名不在声明里）以前全是静默的，
      // 线上只能看到「莫名其妙断了」，所以这里必须把原文与丢弃原因留下来。
      if (!content.trim() && !toolCalls.length) {
        log?.warn('这一轮没有解析出正文或工具调用，客户端将收到空回答', {
          chars: text.length,
          parsedCalls: parsed.length,
          knownTools: knownTools?.length ?? 0,
          sample: text.slice(0, 400),
        });
        if (parsed.length) {
          log?.warn('解析出了工具调用但没交给客户端（不该发生，检查 evaluate 的过滤逻辑）', {
            names: parsed.map((call) => call.name),
          });
        } else {
          // 原来这里调用了两次 findToolMarkup（一次判空、一次取 kind），
          // 协议扫描是全文正则，空回答分支下白跑一遍；算一次复用。
          const blocks = findToolMarkup(text);
          if (blocks.length) {
            log?.warn('模型输出了协议块，但没解析出任何工具调用（工具名不在声明里，或 DSML 结构对不上）', {
              protocolBlocks: blocks.map((block) => block.kind),
            });
          }
        }
      }

      /**
       * 模型不用块、改用别的格式描述调用时，这里必须留痕。
       *
       * 这些格式我们**不解析**（DSML / XML 标签 / JSON 都丢了），调用等于没发生；
       * 但如果不记一笔，现场只能看到"模型什么都没干"，查不出是提示词被误解还是模型飘了。
       */
      if (!toolCalls.length && Array.isArray(request.tools) && request.tools.length) {
        // 有工具但没解析出调用：把工具名和模型输出打个头，方便定位是"没吐代码块"还是"名字对不上"
        const names = request.tools.map((t) => (t?.function ?? t)?.name).filter(Boolean).join(',');
        log.warn('未识别到工具调用', {
          tools: names.slice(0, 120),
          outputHead: String(text || '').replace(/\s+/g, ' ').slice(0, 160),
        });
      }
      if (!toolCalls.length) {
        const looksJson = /"name"\s*:/.test(text) && /"(arguments|args|input)"\s*:/.test(text);
        const looksXml = /<[a-zA-Z][\w:-]*\s+[^>]*\bname\s*=/i.test(text);
        if (looksJson || looksXml) {
          log?.warn('模型用其它格式描述了调用（JSON / XML），已按约定丢弃', {
            shape: looksJson ? 'json' : 'xml',
            sample: text.slice(0, 240),
          });
        }
      }

      // 未知工具名是「模型自己在乱叫」的信号：照实返回（客户端会回一条 unknown tool 让它纠正），
      // 但不能静默——以前这里连日志都没有，出事只能靠猜。
      if (toolCalls.length && knownToolSet) {
        const unknown = toolCalls.filter((call) => !knownToolSet.has(call.name));
        if (unknown.length) {
          log?.warn('模型调用了未声明的工具，已照实返回给客户端', {
            names: unknown.map((call) => call.name),
            declared: knownTools.length,
          });
        }
      }

      // 记住**模型这一轮的原始输出**（含密文块）：客户端回传 assistant 时 content 常常为空，
      // 下一轮拼上下文要靠它把"它刚才说过什么、调过什么"补回去。
      // 存的必须是原文而不是剥离后的正文 —— 剥完就只剩一句"我查一下"，调用记录凭空消失，
      // 模型下一轮会重新猜参数、重复调用同一个工具。
      if (toolCalls.length) rememberRawText(toolCalls, text, config.dataDir);

      return {
        toolCalls,
        content,
        // RESULT / 伪造的 ## 段落标题都算「编造协议」
        fabricated: hasFabricatedProtocol(text),
      };
    };

    /** 可见正文为空时，工具调用可能只写在思考里（DeepSeek 的常见行为）：提升成正式调用 */
    const promoteFromReasoning = (reasoning, reply) => {
      if (reply.content.trim() || reply.toolCalls.length || !reasoning) return reply;
      const toolCalls = finalizeToolCalls(parseToolCalls(reasoning, knownTools, { toolSchemas }));
      return toolCalls.length ? { ...reply, toolCalls } : reply;
    };

    /** 思考内容里若也伪造了协议（RESULT / 段落标题），出口前清掉 */
    const cleanReasoning = (reasoning) =>
      reasoning && hasFabricatedProtocol(reasoning) ? stripToolMarkup(reasoning, knownTools) : reasoning || '';

    /** 原生 reasoning 与 <ds_think> 里抽出的推理拼接（都为空时返回空串） */
    /**
     * 拼接思考内容（原生 reasoning + 从正文里抽出的 <ds_think>）。
     *
     * 必须去重：网页版有时会同时给出原生 THINK 片段**和**正文里的 <ds_think> 块，
     * 两处内容一模一样，直接 join 就会把整段思考吐两遍
     * （实测："根据系统提示，我是 xxx 模型。直接如实回答即可…" 连着出现两次）。
     *
     * 规则：完全相同的跳过；一段被另一段完整包含时保留长的那个。
     */
    /**
     * 折叠"整段重复"：a + a（中间可能夹 0~3 个空白）→ a。
     *
     * 传输层重发、DOM 补尾、断线重连都可能把同一段文本拼成两份，
     * 而且两份常常**连在一起**（"…Chinese.The user asks…"），所以不能靠按行去重。
     */
    const collapseRepeatedHalves = (text) => {
      const whole = String(text ?? '').trim();
      if (whole.length < 24) return whole;
      for (let sep = 0; sep <= 3; sep += 1) {
        const total = whole.length - sep;
        if (total <= 0 || total % 2 !== 0) continue;
        const half = total / 2;
        const head = whole.slice(0, half);
        const middle = whole.slice(half, half + sep);
        const tail = whole.slice(half + sep);
        if (head === tail && /^\s*$/.test(middle)) return head;
      }
      return whole;
    };

    const joinReasoning = (...parts) => {
      const kept = [];
      for (const raw of parts) {
        const part = collapseRepeatedHalves(raw);
        if (!part) continue;
        const duplicated = kept.some(
          (seen) => seen === part || seen.includes(part) || part.includes(seen),
        );
        if (duplicated) {
          // 新的一段更长（把旧的那段整个包进去了）→ 换成长的那份
          const index = kept.findIndex((seen) => part.includes(seen) && part !== seen);
          if (index >= 0) kept[index] = part;
          continue;
        }
        kept.push(part);
      }
      return kept.join('\n');
    };

    // 发送前不做任何停顿：随机抖动和按字数算的延迟都已去掉，直接发。
    const run = async (promptText = sendPrompt, ids = fileIds, hooks = {}) => {
      return web.chat({
        prompt: promptText,
        // 原生「深度思考」：由 resolveThinking 决定（默认开），推理走 reasoning_content
        thinking: request.thinking,
        search: request.search,
        refFileIds: ids,
        signal,
        meta,
        messages: request.messages,
        conversationKey,
        buildDelta: (from) => buildDelta(from, activeSystemExtra),
        onDelta: hooks.onDelta,
        onThinking: hooks.onThinking,
      });
    };

    if (!request.stream) {
      // 不检测、不中断、不截断：模型写多少就收多少，出口只做协议清洗（RESULT 行从正文里剔掉）
      let result = await run(sendPrompt, fileIds);
      const think = extractThinkBlocks(result.text);
      let reply = promoteFromReasoning(result.reasoning, evaluate(think.content));

      if (reply.fabricated) {
        log?.warn?.('模型输出了自造的工具结果（RESULT），已从正文里剔除', {
          toolCalls: reply.toolCalls.length,
        });
      }

      return {
        prompt,
        stats,
        attachment: initial.attachment,
        text: result.text,
        reasoning: joinReasoning(cleanReasoning(result.reasoning), cleanReasoning(think.reasoning)),
        elapsedMs: result.elapsedMs,
      upstreamPromptChars: result.upstreamPromptChars,
      fullPromptChars: result.fullPromptChars,
      continuous: result.continuous,
        // 透传引擎的指标（实发/全量/是否续聊），否则上层日志永远是 undefined
        upstreamPromptChars: result.upstreamPromptChars,
        fullPromptChars: result.fullPromptChars,
        continuous: result.continuous,
        ...reply,
      };
    }

    // 流式：先按 <ds_think> 拆思考/正文，再挡旧格式协议块，
    // 再挡旧格式协议块（<tool_call> / 原生 token / DO），收尾统一核对/补发
    const thinkFilter = new ThinkTagStreamFilter();
    const filter = new ToolMarkupStreamFilter({ knownTools });
    let sentContent = '';
    let sentReasoning = '';
    const emitContent = (text) => {
      if (!text) return;
      sentContent += text;
      onContent?.(text);
    };
    const emitReasoning = (text) => {
      if (!text) return;
      sentReasoning += text;
      onReasoning?.(text);
    };
    const feedBody = (text) => {
      if (!text) return;
      const safe = filter.push(text);
      if (safe) emitContent(safe);
    };
    const feedContent = (content) => {
      if (!content) return;
      feedBody(content);
    };
    const feedDelta = (text) => {
      if (!text) return;
      const { content, reasoning } = thinkFilter.push(text);
      if (reasoning) emitReasoning(reasoning);
      feedContent(content);
    };

    const result = await web.chat({
      prompt: sendPrompt,
      // 原生「深度思考」：由 resolveThinking 决定（默认开），推理走 reasoning_content
      thinking: request.thinking,
      search: request.search,
      refFileIds: fileIds,
      signal,
      meta,
      messages: request.messages,
      conversationKey,
      buildDelta: (from) => buildDelta(from, activeSystemExtra),
      onDelta: feedDelta,
      onThinking: (text) => emitReasoning(text),
    });
    // 收尾把 <ds_think> / 协议过滤里最后扣住的尾巴发出去
    const thinkTail = thinkFilter.flush();
    if (thinkTail.reasoning) emitReasoning(thinkTail.reasoning);
    if (thinkTail.content) feedContent(thinkTail.content);

    const authoritativeText = result.text;
    const finalThink = extractThinkBlocks(authoritativeText);

    const reply = promoteFromReasoning(result.reasoning, evaluate(finalThink.content));
    if (reply.fabricated) {
      log?.warn?.('模型输出了自造的工具结果（RESULT），已从流式 content 中剔除', {
        toolCalls: reply.toolCalls.length,
      });
    }

    // 把被协议块挡住的剩余正文补发出去（有 toolCalls 时也要发：调用之后的自然语言不能丢）
    const rest = filter.flushRest();
    if (rest) emitContent(rest);

    // 收尾核对：SSE 一旦发出去就不能撤回，只能补发尾巴。
    // 浏览器 DOM 的 markdown 序列化与模型原始文本经常不是前缀关系（空行/列表符/收尾符），
    // driver 的流式增量可能停在半路；这里用权威 result.text 清洗后的内容兜底补一次。
    const contentGap = reconcileStreamedText(sentContent, reply.content);
    if (contentGap.delta) {
      log?.debug?.('流式正文比权威文本短，补发尾部', {
        sentChars: sentContent.length,
        finalChars: reply.content.length,
        tailChars: contentGap.delta.length,
      });
      emitContent(contentGap.delta);
    }
    if (!contentGap.complete) {
      log?.warn?.('流式正文与权威文本分叉且无法安全补齐，客户端可能缺一段内容', {
        sentChars: sentContent.length,
        finalChars: reply.content.length,
        toolCalls: reply.toolCalls.length,
      });
    }

    // 思考内容同理补尾（原生 reasoning + <ds_think> 抽出的推理，按同样的顺序核对）
    const finalReasoning = joinReasoning(cleanReasoning(result.reasoning), cleanReasoning(finalThink.reasoning));
    const reasoningGap = reconcileStreamedText(sentReasoning, finalReasoning);
    if (reasoningGap.delta) emitReasoning(reasoningGap.delta);
    if (!reasoningGap.complete) {
      log?.warn?.('流式思考与权威思考分叉且无法安全补齐', {
        sentChars: sentReasoning.length,
        finalChars: finalReasoning.length,
      });
    }

    return {
      prompt,
      stats,
      attachment: initial.attachment,
      text: authoritativeText,
      reasoning: finalReasoning,
      streamedContent: sentContent,
      elapsedMs: result.elapsedMs,
      ...reply,
    };
  };
}
