# freetoken

[**官方tg频道**](https://t.me/xinglingdefuckds)

**重大更新：这次真真真真的不封了！
我们不但成功地完美解决了封号禁言问题，并且我们还解决了网页版模型概率采样参数较高导致的输出不确定性，也就是有些人说的“降智”问题**

将 **chat.deepseek.com 网页版** 包装成 **OpenAI / Anthropic 双协议兼容 API**。

上下文不打在服务端：每条请求都把历史按 `# Messages:` 下的 `## System` / `## Tools` / `## User` / `## Assistant` / `## OTC` / `## OTCR` 段落格式拼成一条 prompt，作为一次**全新对话**发给模型。客户端 system 在最上面，自带的协议提示词夹在中间，工具声明和 user/对话历史在后面。

两种引擎，默认 **direct**（Playwright 驱动真实网页）：

| 引擎 | 原理 | 单轮耗时 | 依赖 |
| --- | --- | --- | --- |
| browser | Playwright 填输入框，DOM 流式展示 + 抓页面原始补全流 | ~2.2–2.9s | Chromium + 依赖库 |
| **direct**（默认，更快） | 直接调网页内部接口 + Go 解 PoW | **~1.2–1.9s** | `bin/ds-pow`（Go 编译） |

```
┌──────────────┐  OpenAI HTTP  ┌──────────────┐  HTTPS + PoW   ┌───────────────────┐
│ OpenAI 客户端 │ ────────────▶ │  本服务      │ ─────────────▶ │ chat.deepseek.com │
│ (SDK/curl)   │ ◀──────────── │ prompt 拼接  │ ◀───────────── │ /api/v0/chat/...  │
└──────────────┘   SSE 流式    └──────────────┘   SSE patch    └───────────────────┘
                                     │ Playwright + Chromium（browser）
```

## 特性

- **OpenAI 兼容**：`POST /v1/chat/completions` 非流式 + SSE 流式；增量与最终文本逐字符一致
- **Anthropic 兼容**：`POST /v1/messages`（流式 / 非流式 / tools / thinking 块）+ `count_tokens`，Claude SDK 直接指过来就能用
- 上下文无状态，每个请求都是一次全新对话
- `tools` → `tool_calls` / `tool_use`：模型按 **OTCL**（Opends Tool Call Language）语法、把调用包在 `!OTCL … -OTCL` 里输出（见下文），服务端解析成标准 `tool_calls`；**块外的普通 JS 代码永远不会被当成工具调用**；**browser 引擎会抓页面原始补全流兜底，保证工具调用 token 不丢**。历史里回写的是 `## OTC` 段的 JSON 行，绝不回写 OTCL 语法
- **解析出的工具调用一律照实返回**：不按「工具名是否在声明里」过滤、也不按「同名同参数」去重——
  两者都会把整轮输出吞成空回答，agent 那边只会看到「模型未返回正文或工具调用」（v2.0.3 修）
- **模型自造工具结果只清洗、不打断**：`RESULT` 单独成段 + 多写法识别 + 出口剔除；**绝不因为检测到编造就中止生成/截断回答**（见下文）
- **超长上下文自动转附件**：超过 165 万字时把较早的对话塞进 `.txt` 附件，用 `ref_file_ids` 注入（见下文）
- **图片输入**：`image_url`（data URL 或 http 链接）→ 自动传成网页附件 → `ref_file_ids`
- 原生「深度思考」默认开启：服务端把模型原生的思考片段映射成 `reasoning_content` / `thinking` 块，**一定排在正文之前**（`DEEPSEEK_THINKING=never` 可关闭）
- 登录态用 `userToken` 注入；直连模式不需要浏览器
- 账号级限流保护：发送间隔 + 冷却重试
- **网页控制台**：`/admin`（React + Vite + [mdui 2](https://www.mdui.org)）管状态 / 号池 / 测试 / 日志 / 配置，不用再敲命令
- 无 root 环境（Android 容器）有现成的 Chromium 依赖解包脚本

---

## 快速开始

要求：Node.js ≥ 23.4（用到内置 `node:sqlite`）、go ≥ 1.21。

```bash
npm install
#安装 Go
sudo apt install golang
npm run pow:build
```
### 1. 拿 userToken

1. 浏览器打开 <https://chat.deepseek.com> 并登录
2. `F12` → **Application** → **Local Storage** → `https://chat.deepseek.com`
3. 键 `userToken`，值是 `{"value":"xxxxx","__version":"0"}`，复制 `value`

**或者**

直接在控制台敲：
```javascript
copy(JSON.parse(localStorage.getItem("userToken")).value)
```

```bash
npm run auth -- '<粘贴的 userToken>'
# ✅ 登录态有效，可以正常对话
```

token 存在 `data/auth.json`（0600，已 gitignore）。

### 2. 启动

```bash
npm run up        # 后台启动（detach，日志 data/server.log，pid data/server.pid）
npm run status    # 看状态 / 引擎 / PoW 是否就绪
npm run restart   # 重启（换 token / 改 HOST·PORT·ENGINE 等启动项用；普通设置保存即生效）
npm run down      # 停止
```

前台跑用 `npm start`。

> **如果用 pm2 托管**（`pm2 list` 里能看到 `index`），重启请用 `pm2 restart index`：
> `npm run down` 杀掉进程后会被 pm2 立刻拉起，`npm run up` 则会发现端口已被占用。
> 改完代码后确认进程启动时间晚于文件 mtime，或直接 `pm2 restart index`。

> **网页控制台（推荐）**：先构建一次前端，然后打开 <http://127.0.0.1:8787/admin>：
>
> ```bash
> npm run admin:install   # 安装 web/ 的前端依赖（React + Vite + mdui）
> npm run admin:build     # 构建到 web/dist，服务会自动托管
> ```
>
> 状态、号池 token、登录态校验、测试请求、日志、配置、重启都能在页面里点。
> 如果配置了 `API_KEY`，打开 `/admin` 会弹框要求输入同一个 key（存在浏览器 localStorage，右上角钥匙图标可修改 / 清除）。
> 开发前端时用 `npm run admin:dev`（Vite 会热更新并把 /admin/api、/v1 代理到 8787）。

### 3. 调用

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "stream": true,
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手"},
      {"role": "user", "content": "用一句话解释什么是 QUIC"}
    ]
  }'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")
stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "用一句话解释 QUIC"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
```

带图片的请求（支持 `data:` URL 和 http 链接，单张 ≤10MB、最多 8 张）：

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-flash",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "这张图是什么颜色？"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0..."}}
      ]
    }]
  }'
# → 红色
```

### 4. Anthropic（Claude）客户端调用

服务同时实现了 Anthropic Messages API，官方 SDK 直接改 `base_url` 就能用：

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key="any")
msg = client.messages.create(
    model="deepseek-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "用一句话解释什么是 QUIC"}],
)
print(msg.content[0].text)
```

```bash
# 非流式
curl -s http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "system": "你是一个简洁的助手",
    "messages": [{"role": "user", "content": "用一句话解释 QUIC"}]
  }'

# 流式 + 工具
curl -N http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "stream": true,
    "tools": [{"name": "exec_shell", "description": "Exec shell command",
               "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}}}],
    "messages": [{"role": "user", "content": "内核是什么版本"}]
  }'

# token 估算
curl -s http://127.0.0.1:8787/v1/messages/count_tokens \
  -H "Content-Type: application/json" -H "x-api-key: any" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"你好"}]}'
```

协议映射关系：

| Anthropic | 本服务内部 | 说明 |
| --- | --- | --- |
| `system`（顶层，字符串 / text 块数组） | `## System` | 多条 text 块按换行合并 |
| `content` 里的 `text` 块 | 正文 | |
| `content` 里的 `image` 块（base64 / url） | `image_url` → 网页附件 | 单张 ≤10MB，最多 8 张 |
| `assistant` 的 `tool_use` 块 | `## OTC` 的 JSON 行 | `input` 对象原样写进 `args` |
| `user` 里的 `tool_result` 块 | `## OTCR` | 独立成段，不会并进 assistant |
| `tools[].input_schema` | `function.parameters` | |
| `thinking: {type:"enabled"}` | 可选的显式开关（默认已开启原生深度思考） | |
| 响应 `stop_reason` | `tool_use` / `end_turn` | |
| 响应 `thinking` 块 | 网页思考内容 | 流式是 `thinking_delta` |

鉴权同时认 `x-api-key: <key>` 和 `Authorization: Bearer <key>`；错误体是 Anthropic 格式
`{"type":"error","error":{"type","message"}}`。`temperature` / `max_tokens` / `tool_choice`
等字段接受但忽略（网页版调不了采样参数）。

端到端自检（会真的访问 DeepSeek）：

```bash
npm run smoke
```

---

## 直连协议（direct 引擎）

```
POST /api/v0/chat_session/create      → 每次请求新建一个会话
POST /api/v0/chat/create_pow_challenge → 拿 PoW 挑战
POST /api/v0/chat/completion          → SSE 流式补全
```

- **PoW 一次性**：解出来的 header 只能用一次，所以每次用掉后立刻在后台解下一个；会话也提前建好
- 请求头带 `authorization`、`x-client-*`、`x-device-id`、`x-ds-pow-response`
- 响应是 JSON 补丁流：`{"v":{...}}` 快照、`{"p":"response/fragments","o":"APPEND","v":[...]}` 新片段、`{"v":"字"}` 追加到当前片段、`{"p":"response/status","v":"FINISHED"}` 结束

### PoW：DeepSeekHashV1

`DeepSeekHashV1` = SHA3-256，但 **Keccak-f[1600] 跳过 round 0**（只做 rounds 1..23）。其余参数不变：`rate=136`、padding `0x06 + 0x80`、输出 32 字节。

```
prefix = salt + "_" + str(expire_at) + "_"
input  = (prefix + str(nonce)).encode("utf-8")
hash   = DeepSeekHashV1(input)                 → 32 bytes
header = base64(json({algorithm, challenge, salt, answer, signature, target_path}))
```

服务端在 `[0, difficulty)`（常见 144000）里选了一个 answer，客户端遍历找到它。Go 实现在 `[0, difficulty)` 上约 **20–30ms**：

```bash
go test ./... && go test -bench=. -benchmem
```

相关文件：

| 文件 | 内容 |
| --- | --- |
| `deepseek_hash.go` | `DeepSeekHashV1` / `keccakF23` |
| `deepseek_pow.go` | `SolvePow`、`BuildPowHeader`、`SolveAndBuildHeader` |
| `cmd/powd/main.go` | 常驻求解器，stdin/stdout JSON 协议 |
| `src/direct/pow.mjs` | Node 侧进程封装 |

---

## 号池（多账号轮询）

限流是按「窗口内消息条数」算的，跟发送间隔无关，所以靠放慢没用。正确做法是准备多个账号：

```bash
npm run auth -- '<token1>' '<token2>' '<token3>'
npm run auth -- --list      # 查看号池（token 打码）
```

行为：

- 请求按轮询分配账号，每个账号有自己的 PoW 缓存、会话池、设备 ID
- 某个账号命中 `rate_limit_reached` → 标记冷却（`ACCOUNT_COOLDOWN_MS`，默认 60s）→ **立刻换下一个账号重试**，不等待
- 某个账号登录态失效 / 上游报错 → **同一个请求里立刻换号重试**，并把坏号停用（登录态失效停用 24h，换 token 或重启后恢复）；
  不会再出现「先撞一次坏号、要客户端重发才能换号，下一次又轮回到坏号」的情况
- 池里全都冷却中：等待不超过 `MAX_COOLDOWN_WAIT_MS`（默认 5s），超过就返回 `429` + `Retry-After`；
  如果全是登录态失效停用的号，直接返回 `503`（提示重新 auth）
- `GET /healthz` 里能看到每个账号的可用状态、剩余冷却、请求数、最近一次失败原因（`lastError` / `authFailed`）

> 直连不再做发送间隔（`DIRECT_SEND_INTERVAL_MS=0`）：既然限流是额度不是速率，放慢只会白白变慢。

## prompt 拼接顺序

一次请求 = 一次全新的网页对话，模型只能靠拼出来的这一条 prompt 判断上下文。拼接顺序固定为
**客户端 system 在最上面、自带协议提示词夹在中间、工具声明和对话历史（user）在后面**：

```
# Messages:
## System
  …客户端传入的 system / 额外约束（最上面）…
## Tools
  function exec_shell(pars) {
    // Exec shell command
    // pars: {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}
  }
## System
  …自带的特殊 token 声明 / OTCL 工具调用规范（中间）…
## User
  …对话历史，直到最后一问（user 在最后）…
## Assistant
  …模型历史回答…
## OTC
  {"name":"exec_shell","args":{"command":"uname -a"}}
## OTCR
  {"name":"exec_shell","result":"Linux …"}
```

- 客户端传入的 **system 放在最上面**，模型先看到调用方的设定；
- 自带的协议提示词（`SPECIAL_TOKENS_HEADER`）夹在客户端 system 和工具声明/对话历史之间；
- **user 消息和对话历史排在最后**，要回答的问题离生成位置最近；
- `## OTC` / `## OTCR` 分别是历史工具调用（Tool_calls）和工具结果（Tool_call_result）段：前者每行一条 JSON，后者单独成段；
- `## Tools` 段按 `TOOL_DECL_MODE` 渲染：`full` 模式下每个工具是一个不带实现的 JS 函数声明（描述和 `pars` 的 JSON schema 写在注释里，如上）；`compact` 模式一行一个，形如 `function exec_shell(pars) // {command:string*, timeout:number} — Exec shell command`（`*` 标必填），体积约剩 1/10；默认 `auto` 放得下用 full，需要拆附件时才切成 compact。

历史里的工具调用**只渲染成 `## OTC` 段里的 JSON 行，绝不回写 OTCL**：
模型输出走 OTCL，但拼接上下文时不能把 OTCL 写回去，否则模型会照抄语法、把调用当正文吐出来。

**工具结果单独成段**（`## OTCR`），不会并进 `## Assistant`。
这是关键：模型是照着自己段落里的写法往后接的，只要 `RESULT` 从不以「assistant 说过的话」的形式出现，
它就没有可模仿的样板。

## 工具调用

模型按 **OTCL**（Opends Tool Call Language，见 [OTCL.md](OTCL.md)）输出工具调用：像写 JavaScript 一样
调用工具函数，参数用一个 JS 对象包起来，服务端解析后转成标准 `tool_calls` / `tool_use`，
并从 `content` / SSE 增量里剔除：

```otcl
!OTCL
exec_shell({command:"ls",timeout:10});
// 块内一行一个调用，以 ; 结束；工具名必须是 ## Tools 里声明过的名字
read_file({path:"/etc/os-release"});
-OTCL
```

- **只有 `!OTCL … -OTCL` 里的文本算工具调用**；块外的一律是普通正文——用户让模型写 JavaScript 时，
  代码就写在块外，不会被误判、也不会被删；
- 块内支持 JS 对象字面量：裸键 / 引号键、单 / 双引号字符串、数字 / 布尔 / `null`、数组 / 对象、尾逗号，
  以及 `//` 与 `/* */` 注释；
- 调用被截断（流式半截 / 缺 `)`、`}`、`;` / 块没闭合）时，尽量把已完整的参数解析出来；
- 流式输出时整个 `!OTCL` 块（含标记）都会先扣住、不发给客户端；块外正文照常流式；
- 解析出来的调用会从 `content` / SSE 增量里剔除，`content` 里不会残留 `!OTCL` 标记或调用文本；
- **解析出来的调用不会因为「名字没在 `tools` 里声明」被丢掉**：模型偶尔会调一个没声明的名字，
  丢掉它等于把这一轮的正文和调用一起吞掉，客户端只会收到一条空 assistant 消息。
  未知名字照实返回，客户端自己回一条 unknown tool，agent 才能自我纠正、loop 才能继续；
- **也不会因为「和上一轮同名同参数」被判成复述**：真实 agent 每一步动作之后都会重发同一个调用
  （例如每步都 `observe_screen`），按签名去重会把这类正常调用全部吞掉。

**拼接上下文时绝不回写 OTCL**：历史里的调用只渲染成 `## OTC` 段的 JSON 行（见上一节），
模型只从 system 提示词里学输出语法，不会从历史里照抄。旧格式（DSML / `<tool_call>` /
原生 `<|tool▁calls▁begin|>` token / 旧版 `DO:` 行）仅作静默兜底解析，不再是对外协议（不记日志、不写历史）。

### 工具调用 token 保护（browser 模式）

网页版模型偶尔会「不听话」：工具调用块出现在最后一行、DOM 渲染延迟、轮询提前判定结束，
都可能让工具调用 token 在半路丢掉。browser 引擎为此做了三层保护：

1. **原始流优先**：页面自己发出的 `POST /api/v0/chat/completion` SSE 由 Playwright 截获
   （`page.on('response')`），用 patch 解析器还原成模型原始输出；`tool_calls` 从原始文本解析，
   DOM 只负责流式展示 —— DOM 提前结束 / 文本回退 / 渲染丢字符都不影响最终结果。
2. **DOM 永不缩水**：轮询期间记录「按前缀增长的最长文本」，结束快照变短会重试并取最长，
   避免末尾的工具调用块被覆盖。
3. **静默兜底解析**：OTCL 是正式协议；旧格式（DSML / `<tool_call>` / 原生 token / 旧版 DO）只作兜底解析，
   不记日志，也绝不回写历史、不会出现在 `content` 里。

`BROWSER_CAPTURE=false` 可关掉第 1 层（退回纯 DOM 提取，不推荐）。

### 模型自造工具结果（RESULT）

网页版模型有个坏习惯：看到 `RESULT` 就自己往后编一段「执行结果」，再把答案建立在这段假结果上。
处理原则只有一条：**只清洗，不打断**。

1. **协议上隔离**：`RESULT` 只出现在 `## OTCR` 段，system 段明确写「绝对不能输出 RESULT」；
2. **识别放宽**：不只认行首 `RESULT:`，`**RESULT:**`、`RESULT：`（全角冒号）、`result:`（小写）、
   `- RESULT:`、`` ``` `` 代码块里的、以及行内 `结果：RESULT:{...}` 都会被识别；
3. **出口剔除**：命中的协议行从 `content` / SSE 增量里删掉，顺带清掉只剩空壳的代码块；模型写在它前后
   的正常正文**照常返回**，一个字都不截断；
4. **不中止、不重试**：编造检测只用于日志（服务日志里搜「自造的工具结果」），不会让引擎停止生成、
   不会掐断流、也不会重跑这一轮 —— 早期版本「检测到 RESULT 就 abort」会把整轮判成失败
   （`AbortError`），是线上偶发丢流的元凶，v2.0.5 起彻底移除。

### 空回答 / 工具调用丢失的排障

历史上有两处「静默丢弃」会让一整轮变成空回答（`content` 为空且没有 `tool_calls`，
客户端只会看到「模型未返回正文或工具调用」）。v2.0.3 起两者都已删除，并补上诊断日志：

| 日志 | 含义 |
|---|---|
| `模型调用了未声明的工具，已照实返回给客户端 { names: [...] }` | 模型自己乱叫了一个 `tools` 里没有的名字（照常返回，客户端会报 unknown tool） |
| `这一轮没有解析出正文或工具调用，客户端将收到空回答 { chars, parsedCalls, knownTools, sample }` | 这一轮真的没有可用输出，`sample` 是模型原文前 400 字 |

看到第一条不用管，看到第二条说明模型既没写字也没给合法调用 —— 把 `sample` 贴出来就能定位是
协议写歪了、还是模型真的空输出。

### 超长上下文：附件注入

网页输入框单次最多 **165 万字**，超了接口直接报错（`context_length_exceeded`）。但聊天接口的
`ref_file_ids` 可以挂附件，附件不占输入框长度，所以拼接后的 prompt 超限时会自动拆一次：

```
正文（≤ MAX_PROMPT_CHARS）：        附件（.txt）：
# Messages:                         # 对话历史（较早部分）
## System                           ## System
  …客户端 system（太大时拆走）…        （早期 system 提示）
## Tools
  …工具声明（永远留在正文）…
## System
  …特殊 token 声明（永远留在正文）…
## CONTEXT_ATTACHMENT:
  较早的 12 个段落已作为附件
  context-53772c8f.txt 上传…
## User
  （最近的段落，直到最后一问）
```

规则：

- 只切在 `## System` / `## Tools` / `## User` / `## Assistant` / `## OTC` / `## OTCR` 段落边界，不切碎单条消息；
- **保留最新的段落**（要回答的问题在最后），较早的进附件；
- **自带协议提示词永远留在正文**（模型要先看到 OTCL 调用格式）；
- 客户端 system 提示过于庞大、正文挤不下足够新的对话时会被移进附件（先移最靠前的）；
- **工具声明永远留在正文**，不会挪进附件：放不下就直接报错，提示改用 `TOOL_DECL_MODE=compact` 压缩声明；
- 最后一段自己就超长（比如读了一个大文件）时，保留它的尾部，前面部分进附件；
- 附件按内容 hash 缓存 30 分钟，同样内容不会重复上传；上传一次约多 0.3~1s；
- 正文里会带一段 `## CONTEXT_ATTACHMENT:` 说明，要求模型先读附件再回答。

实测 12 万字上下文：正文 98,756 字 + 附件 25,572 字，整轮 3.8s，模型能正确引用附件里的内容。

`OVERFLOW_TO_ATTACHMENT=false` 可恢复旧行为（超限直接 413）。浏览器引擎不支持附件，只能直连。


---

## API

| 接口 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI | 聊天补全，支持 `stream` / `tools` / `stream_options.include_usage` |
| `POST /v1/completions` | OpenAI | 旧版补全 |
| `POST /v1/messages` | Anthropic | Messages API，支持 `stream` / `tools` / `thinking` |
| `POST /v1/messages/count_tokens` | Anthropic | token 估算（返回 `input_tokens`） |
| `GET /v1/models` | 通用 | 模型列表 |
| `GET /healthz` | 通用 | 健康检查，返回引擎 / PoW / 会话状态 |
| `GET /` | 通用 | 说明页 |
| `GET /admin` | 控制台 | 网页后台（React + Vite + mdui 2，静态资源由同一进程托管） |

### 后台管理接口

控制台页面在 `/admin`（首次使用先 `npm run admin:install && npm run admin:build`）。
接口都在 `/admin/api/*`，配置了 `API_KEY` 时要求带同一个 key（`Authorization: Bearer <key>` 或 `x-api-key: <key>`）：

| 接口 | 说明 |
| --- | --- |
| `GET /admin/api/overview` | 服务状态 / 账号池 / 运行环境 |
| `GET /admin/api/accounts` | 号池（运行中 + 已保存） |
| `POST /admin/api/accounts` | 保存 token（`{tokens, mode: append\|replace}`） |
| `POST /admin/api/accounts/verify` | 逐条校验登录态（会真的发一条最短消息） |
| `POST /admin/api/accounts/remove` | 删除已保存 token（`{index}`，1 起） |
| `GET /admin/api/config` · `PUT /admin/api/config` | 读写 SQLite `data/config.db`，保存即生效；仅 `HOST` / `PORT` / `ENGINE` / `CONCURRENCY` / `QUEUE_LIMIT` / `WARMUP` 需重启 |
| `GET /admin/api/logs?lines=300` | 读 `data/server.log` 尾部 |
| `POST /admin/api/restart` | 调 `server-ctl restart` 重启服务 |

> 静态页面本身公开，`/admin/api/*` 才鉴权。浏览器端在首次 401 时弹出输入框，
> key 保存在 localStorage（`fuckds-admin-api-key`），右上角钥匙图标可修改 / 清除。

思考：原生深度思考默认开启（`DEEPSEEK_THINKING=always`），服务端把原生思考片段映射成 `reasoning_content`（OpenAI）/ `thinking` 块（Anthropic）。

| 字段 | 行为 |
| --- | --- |
| 图片 `image_url` | ✅ 直连引擎支持（data URL / http） |
| `stream` | ✅ 真流式 |
| `stream_options.include_usage` | ✅ 末尾 usage（按字符估算；`completion_tokens` 含思考 token，和 OpenAI 口径一致，客户端 tok/s 不会虚低） |
| `tools` / `tool_calls` | ✅ |
| `reasoning_content` | ✅ 先于 `content` 输出 |
| `temperature` / `top_p` / `max_tokens` / `stop` | ⚠️ 接受但忽略 |
| 图片 / 音频输入 | ❌ 返回 400 |

---

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ENGINE` | `direct` | `browser`/ `direct`（需 ds-pow，更快）/ `auto`（有 ds-pow 就直连） |
| `POW_BIN` | `bin/ds-pow` | Go PoW 求解器路径 |
| `DEEPSEEK_USER_TOKEN` | – | 登录态，推荐 `npm run auth` 写文件 |
| `DEEPSEEK_SEARCH` | `false` | 是否开「智能搜索」 |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | 监听地址 |
| `API_KEY` | 空 | 设置后要求 `Authorization: Bearer <key>`（后台接口也要求同一个 key） |
| `CONCURRENCY` | `1` | 并发请求数 |
| `SEND_INTERVAL_MS` | `4000` | 两次发送的最小间隔 |
| `RATE_LIMIT_BACKOFF_MS` | `4000` | 命中限流后的冷却（按次数递增） |
| `REQUEST_TIMEOUT_MS` | `240000` | 单次请求超时 |
| `POLL_INTERVAL_MS` | `60` | 浏览器引擎的 DOM 轮询间隔 |
| `SETTLE_MS` | `800` | 浏览器引擎判定生成结束 |
| `REASONING_HOLD_MS` | `900` | 首段正文最多等思考多久 |
| `WARMUP` | `true` | 启动时预热（browser：Chromium；direct：PoW+会话） |
| `BROWSER_CAPTURE` | `true` | browser 引擎抓页面原始补全流，保证工具调用 token 不丢 |
| `BROWSER_CAPTURE_WAIT_MS` | `20000` | DOM 判定结束后，最多再等原始流收尾多久（补尾部 token） |
| `MAX_PROMPT_CHARS` | `1650000` | 单次输入框上限；超过就拆附件 |
| `MAX_ATTACHMENT_CHARS` | `2000000` | 拆到附件的上下文上限（字符） |
| `OVERFLOW_TO_ATTACHMENT` | `true` | 超长时转附件；`false` 则超限直接 413 |
| `IDLE_SHUTDOWN_MS` | `900000` | 浏览器引擎空闲回收 |

上面这些（以及日志级别、并发、超时等）大多可以在网页控制台的「设置」页直接改：配置写入 SQLite `data/config.db` 并**即时生效**，只有 `HOST` / `PORT` / `ENGINE` / `CONCURRENCY` / `QUEUE_LIMIT` / `WARMUP` 需要重启。老 `.env` 只会在首次建库（表为空）时迁移一次，之后不再读写；不迁移也可以，所有值都有默认值。默认值说明见 [.env.example](.env.example)。

---

## 目录结构

```
src/
├── engine.mjs            # direct / browser 选择
├── index.mjs             # 启动入口
├── server.mjs            # HTTP 路由 + 两个协议的响应编排
├── chat-runner.mjs       # 协议无关的执行逻辑（防自造结果 / 超长转附件）
├── direct/               # 直连引擎
│   ├── client.mjs        # 会话 / PoW / 补全
│   ├── pow.mjs           # Go 求解器封装
│   └── stream.mjs        # SSE patch 解析
├── browser/              # Playwright 引擎：DOM 流式 + 原始补全流截获
├── config.mjs            # 配置加载 / 热更新映射
├── config-store.mjs      # SQLite 配置存储（data/config.db）
├── prompt/               # prompt 拼接 / 超长转附件 / OTCL 工具协议解析
│   ├── special.mjs       # 特殊 token 声明（system 提示词）
│   ├── build.mjs         # 历史 → ## 段落 prompt
│   ├── tools.mjs         # 工具声明渲染 / 参数纠正
│   ├── otcl.mjs          # OTCL 调用解析 / 流式识别
│   ├── dsml.mjs          # 旧格式（DSML）兜底解析
│   └── overflow.mjs      # 超长转附件
├── admin/                # 网页控制台接口（/admin/api/* + web/dist 静态托管）
├── anthropic/            # Anthropic Messages API（请求归一化 / 块与事件 / SSE）
└── openai/               # OpenAI 协议 / SSE / 工具文本过滤
cmd/powd/main.go          # Go PoW 求解器
web/                      # 后台前端（React + Vite + mdui 2，构建产物 web/dist）
deepseek_hash.go          # DeepSeekHashV1
deepseek_pow.go           # SolvePow / header 组装
```

## 测试

```bash
npm test        # 全部用例（浏览器相关的在没装 Chromium 时自动跳过）
npm run smoke   # 真实接口：非流式 / 流式 / 多轮 / 工具
```

## 常见问题

**为什么慢 / 怎么更快**
browser 引擎单轮 2.2–2.9s（浏览器导航 + DOM 轮询）；直连引擎单轮 1.2–1.9s。原生深度思考默认开启，开启时单轮会多出思考耗时。客户端显示的 tok/s 会把首字延迟算进分母，工具调用还是两轮往返，所以看起来偏低。

**多轮工具调用为什么慢 / 返回 429**
每次工具调用 = 一条消息 = 一次完整请求（建会话 + PoW + 补全）。账号有短时的消息预算，连着发几轮就会命中 `消息发送过于频繁`（接口用 `event: hint` 里的 `rate_limit_reached` 返回）。

现在的处理：

- browser 每轮间隔 `SEND_INTERVAL_MS`（4000ms）；直连默认 `DIRECT_SEND_INTERVAL_MS=0`
- 命中限流（接口用 `event: hint` 的 `rate_limit_reached`，或者干脆只回一个空事件）→ 冷却 `RATE_LIMIT_BACKOFF_MS` 重试一次
- 仍失败返回 `429`，带 `Retry-After: 60`，错误码 `deepseek_rate_limited`

实测这个窗口大概一分钟：连续 3~4 条消息后会被挡，静置一分钟左右恢复。这是账号级预算，服务端没法绕开；工具轮次多的场景建议放慢节奏，或改用官方 API。

**图片输入有什么限制**
只支持直连引擎（`ENGINE=direct`）；browser 引擎会返回 400。单张 ≤10MB、一条请求最多 8 张。同一张图会按内容 hash 缓存 file id 30 分钟，重复问不会重复上传。

**页面/接口改版**
直连：改 `src/direct/client.mjs` 的路径和字段；兜底：改 `src/browser/page-scripts.mjs` 顶部的选择器。

**网页控制台打不开 / 只有一行提示**
前端要先构建：`npm run admin:install && npm run admin:build`，产物在 `web/dist`。
如果看到「控制台还没构建」，按页面上的命令跑一遍即可；开发时也可以用 `npm run admin:dev`。

**配了 API_KEY，怎么访问控制台**
打开 `/admin` 后页面会弹框要求输入 key（和 API 用的是同一个 `API_KEY`），输一次存在浏览器 localStorage；
以后换 key 或清除，点右上角的钥匙图标。也可以在「设置」页修改 `API_KEY`（写入 SQLite，保存后下一次请求即生效），或通过环境变量覆盖。
## tips


如果你的IP不是**中国大陆**，就可以使用邮箱注册DeepSeek账号，且支持变体，比如your+1@gmail.com这种写法都能成功注册账号

我们在取多账号token的时候不要直接点击“退出账号” 因为这样会直接吊销之前的userToken，正确做法是直接清除localStorage和cookies（其实只清localStorage也可以但可能在登录新账号时会出现设备异常等无法登录情况，所以建议cookies也一起清掉）


## 免责声明

本项目只做协议封装，不是 DeepSeek 官方产品。请遵守其服务条款；账号风险（限流、风控、封禁）由使用者自行承担。
## License

[AGPLv3](./LICENSE)
