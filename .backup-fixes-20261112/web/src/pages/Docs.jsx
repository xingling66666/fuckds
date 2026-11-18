import { adminApi } from '../api.js';
import { Btn, Card, toast } from '../ui.jsx';

export default function Docs() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>文档</h1>
          <p className="muted">常用接口、调用示例和 prompt 协议速查。完整说明见项目根目录 README.md。</p>
        </div>
      </div>

      <Card title="基础信息">
        <DocSection>
          <dl className="kv">
            <dt>Base URL</dt>
            <dd className="mono">http://127.0.0.1:8787</dd>
            <dt>鉴权</dt>
            <dd>
              <code>Authorization: Bearer &lt;API_KEY&gt;</code> 或 <code>x-api-key: &lt;API_KEY&gt;</code>；没配置 API_KEY 时随便填
            </dd>
            <dt>OpenAI 兼容</dt>
            <dd className="mono">POST /v1/chat/completions · POST /v1/completions · GET /v1/models</dd>
            <dt>Anthropic 兼容</dt>
            <dd className="mono">POST /v1/messages · POST /v1/messages/count_tokens</dd>
            <dt>健康检查</dt>
            <dd className="mono">GET /healthz</dd>
          </dl>
        </DocSection>
      </Card>

      <Card title="OpenAI 调用">
        <DocSection title="curl（流式）">
          <CodeBlock
            code={`curl -N http://127.0.0.1:8787/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer any" \\
  -d '{
    "model": "deepseek-flash",
    "stream": true,
    "messages": [
      {"role": "system", "content": "你是一个简洁的助手"},
      {"role": "user", "content": "用一句话解释什么是 QUIC"}
    ]
  }'`}
          />
        </DocSection>
        <DocSection title="Python（openai SDK）">
          <CodeBlock
            code={`from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="any")
stream = client.chat.completions.create(
    model="deepseek-flash",
    messages=[{"role": "user", "content": "用一句话解释 QUIC"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`}
          />
        </DocSection>
        <DocSection title="工具调用（tools）">
          <CodeBlock
            code={`curl -N http://127.0.0.1:8787/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "deepseek-flash",
    "messages": [{"role": "user", "content": "看看内核版本"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "exec_shell",
        "description": "Exec shell command",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}}
      }
    }]
  }'`}
          />
        </DocSection>
      </Card>

      <Card title="Anthropic 调用">
        <DocSection>
          <CodeBlock
            code={`curl -s http://127.0.0.1:8787/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: any" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "deepseek-flash",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "用一句话解释 QUIC"}]
  }'`}
          />
        </DocSection>
        <DocSection title="Python（anthropic SDK）">
          <CodeBlock
            code={`from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key="any")
msg = client.messages.create(
    model="deepseek-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "用一句话解释 QUIC"}],
)
print(msg.content[0].text)`}
          />
        </DocSection>
      </Card>

      <Card title="Prompt 协议">
        <DocSection>
          <p>
            每条请求都是一次全新的网页对话，历史由服务端拼成一条 prompt。段落顺序固定：
          </p>
          <CodeBlock
            code={`# Messages:
## System
…客户端传入的 system…
## Tools
function exec_shell(pars) {
  // Exec shell command
  // pars: {"type":"object","properties":{"command":{"type":"string"}}}
}
## System
…自带的特殊 token 声明 / OTCL 工具调用规范…
## User
…历史用户消息…
## Assistant
…模型历史回答…
## OTC
{"name":"exec_shell","args":{"command":"uname -a"}}
## OTCR
{"name":"exec_shell","result":"Linux …"}
## User
…要回答的问题（离生成位置最近）…`}
          />
          <p>
            <strong>工具调用由模型按 OTCL（Opends Tool Call Language）输出</strong>：调用必须包在 <code>&lt;!OTCL&gt;...&lt;/OTCL&gt;</code> 里（块外代码按普通正文处理），
            服务端解析成标准 <code>tool_calls</code> / <code>tool_use</code>，并从 <code>content</code> / SSE 里剔除；
            历史里绝不回写 OTCL，历史工具调用统一放在 <code>## OTC</code> 段里。
          </p>
          <CodeBlock
            code={`!OTCL
exec_shell({command:"uname -a", timeout:10});
read_file({path:"/etc/hosts"});
-OTCL`}
          />
          <p>
            <strong>工具结果单独成段</strong>（<code>## OTCR</code>），不并进 <code>## Assistant</code>，
            模型没有可模仿的「自己写结果」样板。旧格式（DSML / &lt;tool_call&gt; / 原生 token / 旧版 DO）仅作静默兜底解析。
          </p>
        </DocSection>
      </Card>

      <Card title="号池与限流">
        <DocSection>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9, fontSize: 13 }}>
            <li>DeepSeek 网页按「窗口内消息条数」限流，不是按发送间隔。多准备几个 userToken 撞限流自动换号。</li>
            <li>账号被限流会进入冷却（<code>ACCOUNT_COOLDOWN_MS</code>），池里全冷却时最多等 <code>MAX_COOLDOWN_WAIT_MS</code>，超过返回 429。</li>
            <li>登录态失效的号会被停用，直到换 token 或重启进程。</li>
            <li>换号：到「账号」页粘贴保存 → 重启服务生效。</li>
          </ul>
        </DocSection>
      </Card>

      <Card title="超长上下文（自动转附件）">
        <DocSection>
          <p>
            网页输入框单次上限约 10 万字。拼接后的 prompt 超限时，较早的对话会拆成一个 <code>context-*.txt</code> 附件，
            用 <code>ref_file_ids</code> 注入，正文保留最近的段落；正文里会放一段 <code>## CONTEXT_ATTACHMENT</code> 说明。
            客户端 system 在空间不足时可以拆进附件；工具声明永不进附件，放不下会明确报错并提示改用 compact 模式。
          </p>
        </DocSection>
      </Card>

      <Card title="后台管理接口">
        <DocSection>
          <p>都是同源接口，配置了 <code>API_KEY</code> 时需要带同一个 key。</p>
          <CodeBlock
            code={`GET  /admin/api/overview          服务状态 / 账号池 / 运行环境
GET  /admin/api/accounts          号池（运行中 + 已保存）
POST /admin/api/accounts          保存 token  {tokens, mode: append|replace}
POST /admin/api/accounts/verify   校验登录态 {tokens}
POST /admin/api/accounts/remove   删除已保存 token {index}
GET  /admin/api/config            读取可改配置
PUT  /admin/api/config            写入 SQLite data/config.db {values}，保存即生效
GET  /admin/api/logs?lines=300    读日志尾部
POST /admin/api/restart           重启服务`}
          />
        </DocSection>
      </Card>

      <Card title="常用命令">
        <DocSection>
          <CodeBlock
            code={`npm run up          # 后台启动（日志 data/server.log）
npm run down        # 停止
npm run status      # 查看状态
node scripts/server-ctl.mjs restart   # 重启
npm run auth -- <userToken>           # 命令行写 token（等价于后台「账号」页）
npm run smoke       # 端到端自检（会真的访问 DeepSeek）`}
          />
        </DocSection>
      </Card>
    </div>
  );
}

function DocSection({ title, children }) {
  return (
    <div className="doc-section">
      {title ? (
        <h2>
          {title}
        </h2>
      ) : null}
      {children}
    </div>
  );
}

function CodeBlock({ code }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('已复制');
    } catch {
      toast('复制失败');
    }
  };
  return (
    <div className="code-block">
      <pre>
        <code>{code}</code>
      </pre>
      <Btn className="copy" variant="text" icon="content_copy" onClick={copy} title="复制" />
    </div>
  );
}
