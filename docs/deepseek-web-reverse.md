# DeepSeek 网页版逆向笔记

> 记录 chat.deepseek.com（前端 v2.8.0，2026-11 实测）的鉴权、请求形态、风控判定与反封策略。
> 所有结论来自：真机抓包（Android Edge 157）、浏览器自动化复现、接口实测。

---

## 1. 鉴权：不是 cookie，是 Bearer

```
Authorization: Bearer <userToken.value>
```

`userToken` 存在 localStorage，有两种形态：

| 形态 | 内容 | 说明 |
|---|---|---|
| 旧 | `{"value":"<明文 token>","__version":"0"}` | token 直接当 Bearer |
| 新（v2.8.0） | `{"value":"<明文 token>","__version":"0"}` | **仍然是明文**；但同账号还会有 `settingsJwt` |

**注意两个容易搞混的东西**：

- `userToken` → 聊天接口的 `Authorization: Bearer`
- `settingsJwt` → `{"ownerHash":"f02a8e30bb882","jwt":"<JWE>"}`，是**设置接口**的 `x-settings-token` 头，不是登录凭证

`settingsJwt` 里的 `jwt` 是 JWE（`{"alg":"dir","enc":"A256GCM"}`，5 段 compact），前端按
`ownerHash === hash(ownerToken)` 校验后才取用——**搬走就失效，属于设备绑定**。

### 不可搬运（重要）

token 与「设备 id + 数美指纹 + 出口 IP + UA」绑定。把 A 环境签发的 token 拿到 B 环境用，
通常 **10 分钟内就会被吊销（40003）**，且吊销不可逆。

> 实测：手机注册的 token 拿到服务器（WARP 日本出口 + 桌面 Chromium）使用，
> `probeToken` 一开始返回 `code:0`，发一次真实请求后立刻 40003。

---

## 2. 真机请求头（Android Edge 抓包，2026-11）

```
POST /api/v0/chat/completion
x-ds-pow-response: <base64({algorithm,challenge,salt,answer,signature,target_path})>
x-hif-leim:  <attestation>
x-hif-dliq:  <attestation>          ← 两个都要发
x-device-id: 2d70ce31-d4ff-43f6-b7c2-51e857867812
x-client-bundle-id: com.deepseek.chat
x-client-platform: web
x-client-version: 2.8.0
x-client-locale: zh_CN
x-client-timezone-offset: 28800     ← 秒，正数（东八区）
authorization: Bearer <userToken>
content-type: application/json
accept: */*
user-agent: Mozilla/5.0 (Linux; Android 10; K) ... EdgA/157.0.0.0
referer: https://chat.deepseek.com/a/chat/s/<session_id>
```

响应头里的 `x-ds-trace-id` 是**服务端下发**的，客户端不需要发。

### 请求体

```json
{
  "chat_session_id": "bf497ac0-...",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "你好",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false,
  "shumei_device_id": "BJik4Cy5...=="
}
```

`shumei_device_id` 是真机一定带的字段（`B...==`，约 88 字）。拿不到时宁可发空串，也不要**缺字段**。

---

## 3. SSE 协议（`text/event-stream`）

```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":1794556355.7576258}

data: {"v":{"response":{...,"fragments":[{"id":2,"type":"RESPONSE","content":"你好",...}]}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":"！"}
data: {"v":"有什么"}                       ← 追加到最后一段
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":41},{"p":"quasi_status","v":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: title
event: close
```

解析要点：
- `{"v":...}` 是快照，`{"p":...,"o":"APPEND"|"SET",...}` 是增量
- **fragments 要按 id 去重**（上游会重发同一批片段，否则思考内容会重复）
- `response/status = FINISHED` 表示结束

---

## 4. 风险码表

| code | 含义 | 处理 |
|---|---|---|
| `40003` | INVALID_TOKEN / Authorization Failed | token 已死，不可恢复 |
| `40029` | IP_ACCESS_RESTRICTED | 出口 IP 被限，换 IP |
| `40300/40301` | PoW 相关 | 重新解 PoW |
| `40303/40304` | 人机挑战 | 换 IP / 降频 |
| `40012` | USER_IS_BANNED | 号废了 |
| `50006` | MUTED | 禁言 |
| `40002/40003` | 鉴权失败 | — |
| `40006/40007` | 加密请求失败 | 检查 RSA/AES 公钥（生产用 `eL`） |
| **biz_code 11** | **RISK_DEVICE_DETECTED** | 设备/环境风控，注册时表现为 `注册失败，请稍后再试 (B11)` |

> 前端 toast 格式统一是 `(B<code>)`，`B11` 就是 `biz_code 11`。
> 触发后**不要连续重试**——每次失败都累计风险分，越试越死；换 IP + 换干净环境再试。

---

## 5. localStorage 全表（`copy(localStorage)` 的内容）

### 关键（决定能不能用）

| 键 | 作用 |
|---|---|
| `userToken` | Bearer 真身 |
| `deepseek-device-id:chat` | 设备 id，必须与 `x-device-id` 一致 |
| `.thumbcache_<md5(organization)>` | 数美指纹存储，organization = `P9usCUBauxft8eAmUXaZ` |
| `smidV2` | 数美 smid（和 thumbcache 配对） |
| `hif_leim_cached` / `hif_dliq_cached` | HIF 证明缓存（带 TTL） |
| `settingsJwt` | 设置接口的 `x-settings-token`（非登录凭证） |
| `__appKit_userInfo` | 账号 id |
| `__tea_cache_tokens_20006317` | 火山引擎埋点身份（`web_id` / `user_unique_id`） |

### 行为参数（解释"为什么不像人"）

| 键 / 远端配置 | 值 | 影响 |
|---|---|---|
| `search_state_on_login` | `on` | 登录后搜索默认开 → `search_enabled: true` |
| `pow_prefetch` / `pow_prefetch_count` | `true` / `1` | 真机预取 PoW，首字更快 |
| `completion_request_timeout_ms` | `60000` | 超时基准 |
| `sse_auto_resume_timeout` | `3000` | SSE 断流 3s 自动 resume |
| `launch_clean_session_interval_seconds` | `21600` | 6 小时清一次会话 |
| `normal_history_and_file_token_limit` | `890880` | 上下文 token 上限 |
| `chat_hcaptcha` | `true` | 聊天挂 hCaptcha 风控 |
| `hif_max_retry_interval_secs` | `600` | HIF 重试上限 |

### 模型能力（`__ds_remote_feature_store_model`）

| model_type | 名称 | 状态 |
|---|---|---|
| `default` | 快速模式 | enabled |
| `expert` | 专家模式 | disabled（新号） |
| `vision` | 识图模式 | disabled（新号） |

`default` 限制：输入 2,621,440 字符、文件 890,880 token、最多 50 个文件、单文件 100MB。

---

## 6. 反封策略（按重要性）

1. **token 不能跨环境搬**：必须在将要运行的环境里签发/登录。
2. **登录必须在真浏览器里跑**（`DS_ENGINE=hybrid` 的登录侧）：device/数美/埋点/HIF 由浏览器自己长出来；
   「粘贴 localStorage 导入真人档案」这条链路已移除，后台只支持直接填 userToken。
3. **`x-hif-leim` + `x-hif-dliq` 都发**，缺一个就少一项证据。
4. **数美 `shumei_device_id`** 能拿真值就拿（`B...==`），拿不到发空串也不要缺字段。
5. **节奏**：最小间隔 5s + 抖动、60s 内 ≤8 次、每日上限。实测 31 秒 6 连发会在 90 秒后被吊销。
6. **会话复用**：同一会话内只发增量，不每轮重发全量上下文。
7. **账号级惩罚**：吊销两次 ≈ 废号（后续请求持续被挑战）。本项目有 `data/account-bans.json` 记账。
8. **别公网中转**：多号共用一套出口是最快的封号路径。

---

## 7. 拿号（登录）：浏览器自动登录

导入「真人档案」（把 `copy(localStorage)` 的整包粘进后台）这条链路**已经整条砍掉**：
档案落盘后没有消费方、浏览器启动时也不再注入任何 localStorage。
现在唯一的拿号方式是**在真浏览器里跑完整登录流程**：

```
后台 → 账号 → 「自动登录」填邮箱/密码
  → Playwright 打开 chat.deepseek.com（locale=zh-CN）
  → 点「密码登录」→ 填表 → 真实点击「登录」
  → 需要时走数美点选（OpenCV）+ 邮箱验证码（IMAP）
  → 读 localStorage.userToken → 写入号池（追加，不会顶掉池里其它号）
```

等价的命令行方式：

```bash
npm run auth -- <userToken>   # 已经有 token 时直接喂
npm run login                 # 或者走全自动登录
```

落点只有 `data/auth.json`（token + deviceId）与号池表；`data/profiles/` 不再写入。

转发侧（`POST /api/v0/chat/completion` 等）不再经过浏览器，见第 11 节与本仓库 `src/direct/`。

## 8. 常见坑

| 现象 | 原因 |
|---|---|
| `Bearer [object Object]` | 把 `{ownerHash,jwt}` 当成 token 用了；真正的 token 在 `userToken.value` |
| 刚导入能用、10 分钟后 40003 | token 跨环境搬运，被判定设备不符 |
| 请求成功但一直不发正文 | SSE 里只有 `thinking` 片段，正文在 `phase:"answer"` |
| 思考内容重复两遍 | fragments 没按 id 去重 |
| 注册报 `(B11)` | 设备风控，换 IP + 干净浏览器环境，别连点重试 |
| `probeToken` 说 alive，实际请求 40003 | 探测接口不触发风控链路，真请求才判 |


---

## 9. 网页版「原生工具」长什么样：SEARCH 片段（不是 DSML）

这是关键区别。网页端唯一的"工具"是**服务端侧联网搜索**，它不以 tool_call 形式出现，
而是作为响应里的一个 **fragment**：

```jsonc
// 首次快照：fragments 里多一个 SEARCH 片段，带模型自己生成的查询词
{"v":{"response":{
  "search_enabled": true,
  "search_triggered": true,
  "conversation_mode": "DEFAULT",
  "fragments":[
    {"id":2,"type":"SEARCH","status":"WIP","content":null,
     "queries":[{"query":"郑州2026年11月13日的天气怎么样"},
                {"query":"郑州市2026年11月13日天气预报"}],
     "results":[]}
  ]}}}

// 搜索结果回填
{"p":"response/fragments/-1","o":"BATCH","v":[
  {"p":"queries","v":[]},
  {"p":"results","v":[{"url":"https://www.weather.com.cn/weather/101180101.shtml",
                       "title":"郑州天气预报…","snippet":"13日（今天） 多云转晴 16/6℃","cite_index":1}]}
]}

// 会话模式切到 SEARCH，片段收尾
{"p":"response/conversation_mode","o":"SET","v":"SEARCH"}
{"p":"response","o":"BATCH","v":[{"p":"fragments","v":[
  {"id":2,"type":"SEARCH","status":"FINISHED","content":"搜索到 10 个网页","queries":[],"results":[…]}
]}]}

// 正文用 [citation:N] 引用搜索结果
{"p":"response/fragments/-1/content","o":"APPEND","v":"今天"}
```

正文里的引用形如 `早晚温差较大[citation:1][citation:2][citation:5]`，`N` 对应
`results[].cite_index`。

**结论**：网页客户端的"工具使用"完全由服务端片段承载，客户端从不输出 tool_call。
因此在网页接口上出现的 `<｜DSML｜invoke name="…">` **只可能来自非官方客户端**——
这正是"自报家门"的机制。

---

## 10. 登录链路实测（2026-11-14，真浏览器）

### 10.1 密码登录的请求体（加密前明文）

```json
{"email":"a@b.com","mobile":"","area_code":"","password":"***",
 "device_id":"Bj1AD+6tDTqsHCNF760TEjb/...==","os":"web","credential_id":""}
```

- `content-type: application/json`，另有 `x-request-encryption-key`（344 字符，RSA-OAEP 包裹的 AES key+IV），body 是 AES-CBC 密文（原始字节）。
- **`device_id` 不是 UUID，是数美设备号（`B...==`，88 字节）**。数美 SDK 没跑完时它是 `null`，服务端直接 `422 {"detail":[{"loc":"body.device_id"}]}` —— 这是 DTO 校验，不是风控。纯 HTTP 反代永远拿不到这个值。

### 10.2 三种登录结果

| 现象 | 含义 | 处理 |
|---|---|---|
| `biz_code 0` + token | 直接通过 | 取 `userToken.value` 入池 |
| `biz_code 14` `MFA_VERIFICATION_CODE_REQUIRED` + `mfa_session_id` | 要求邮箱验证码 | 点「发送验证码」→ 收邮件 → `mfa/check_verification_code` |
| `422 body.device_id` | 数美设备号未就绪 | 等 3–5 秒重试，别连点 |

### 10.3 MFA 的两道门

1. 点「发送验证码」会先弹**数美点选**：`点击图中最小的绿色三棱柱`（`select` / `spatial_select`）。
2. 过了之后邮件才发出，再填 6 位码 → `mfa/check_verification_code` → `mfa_ticket`。

MFA 相关请求（客户端原文）：

```
POST /api/v0/users/mfa/create_verification_code
  {mfa_session_id, shumei_verification, hcaptcha_token, shumei_device_id, turnstile_token}
POST /api/v0/users/mfa/check_verification_code
  {mfa_session_id, verification_code}   → biz_data.mfa_ticket
POST /api/v0/users/mfa/trusted_device/register
  {mfa_ticket, mfa_public_key, mfa_algorithm:"ES256"}
```
`mfa/create_verification_code` 在 **guest PoW + 挑战白名单**里（`/v0/users/register`、`create_email_verification_code` 等同组），所以这一步一定会被人机验证拦。

### 10.4 验证码按区域路由

- `provider` 由**服务端**下发（`data.provider ∈ {shumei, hcaptcha}`），客户端无条件跟随。
- 数美 `expected_mode`：`slide | select | icon_select | seq_select | spatial_select`。
- 实测：中国 IP（125.42.97.202）→ 数美点选；非中国大陆 IP → hCaptcha。

### 10.5 风险分是累积的（同日实测）

```
15:30 首次密码登录（全新 profile + 家宽 IP）→ 零验证码，直接成功
15:32–15:36 反复重试登录 4 次（多次 422、重建 profile）
15:49 再登录 → 要求邮箱验证码（biz_code 14）
15:55 点「发送验证码」→ 数美点选
```

**同一设备/IP 反复登录 = 自杀式养号**。验证码不是门槛，是罚单。

## 11. 为什么删掉纯协议通道

| 判据 | 纯协议（已删） | 真浏览器 |
|---|---|---|
| TLS/JA3 + HTTP2 帧 | Node/OpenSSL 指纹 | Chromium 原生 |
| `x-hif-leim` / `x-hif-dliq` | 得自己轮询两个域名 | 页面自己维护 |
| 数美 `smidV2` / `.thumbcache_*` | 拿不到（要 SDK + 设备profile 往返） | 自动生成 |
| `interaction_pointer_move` 遥测 | 0 条 | 真实轨迹 |
| 登录 `device_id` | 拿不到（见 10.1） | 自动 |

一句话：直连缺的不是某个字段，是**整条证据链**。
