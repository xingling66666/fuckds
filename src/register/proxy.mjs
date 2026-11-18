/**
 * 代理串解析：把用户随手填的东西规范成 Playwright 能吃的形式。
 *
 * 支持：
 *   http://host:port            http://user:pass@host:port
 *   https://host:port
 *   socks5://host:port          socks5h://host:port（h 去掉，Chromium 不认）
 *   host:port                   无协议，按端口猜：1080/1081 → socks5，其余 → http
 *   user:pass@host:port
 *
 * 注意：Chromium 的 SOCKS5 **不支持用户名密码认证**，带认证的 socks5 会失败，
 * 这里会在 testProxy 里明确报出来，别让人以为是「代理不通」。
 */

export function normalizeProxy(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^(https?|socks5h?|socks4):\/\//i.test(s)) {
    return s.replace(/^socks5h:\/\//i, 'socks5://');
  }
  const m = /^(?:([^@\s]+)@)?([^:\s/]+):(\d{1,5})$/.exec(s);
  if (m) {
    const [, auth, host, port] = m;
    const scheme = ['1080', '1081'].includes(port) ? 'socks5' : 'http';
    return `${scheme}://${auth ? `${auth}@` : ''}${host}:${port}`;
  }
  if (s.includes('@') && !s.includes('//')) return `http://${s}`;
  return `http://${s}`;
}

export function proxyScheme(proxy) {
  const m = /^([a-z0-9]+):\/\//i.exec(String(proxy || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 给界面提示用：这个代理串有没有明显问题 */
export function describeProxy(raw) {
  const proxy = normalizeProxy(raw);
  if (!proxy) return { proxy: '', scheme: '', warning: '' };
  const scheme = proxyScheme(proxy);
  let warning = '';
  if (scheme === 'socks5' && /@/.test(proxy)) {
    warning = 'Chromium 的 SOCKS5 不支持用户名密码认证，请改用 http 代理或免认证的 socks5';
  }
  if (!['http', 'https', 'socks5', 'socks4'].includes(scheme)) {
    warning = `不认识的协议：${scheme}`;
  }
  return { proxy, scheme, warning };
}


/**
 * 出口 IP 一致性检查。
 *
 * 为什么重要：我们实测这台机器的出口是 Cloudflare 边缘隧道，**每次请求换一个 IP**
 * （104.28.162.203 → .114 → .51 …）。同一个注册会话里 IP 乱跳，是平台最容易识别的
 * 机器人特征，表现就是 biz_code=9（伪装成"域名不支持"）或 11（设备风控）。
 *
 * 注册前先连打两次，IP 不一致就直接告警。
 */
export async function checkExitIp(proxy = '', { attempts = 3, timeoutSec = 12 } = {}) {
  const { execFile } = await import('node:child_process');
  const ips = [];
  for (let i = 0; i < attempts; i += 1) {
    const args = ['-sS', '--max-time', String(timeoutSec)];
    if (proxy) args.push('--proxy', proxy);
    args.push('https://api.ipify.org');
    const ip = await new Promise((resolve) => {
      execFile('curl', args, { timeout: (timeoutSec + 3) * 1000 }, (err, stdout) => {
        resolve(err ? '' : String(stdout || '').trim());
      });
    });
    if (ip) ips.push(ip);
    await new Promise((r) => setTimeout(r, 800));
  }
  const uniq = [...new Set(ips)];
  return {
    ips,
    unique: uniq,
    stable: uniq.length <= 1,
    ok: ips.length > 0,
    hint: uniq.length > 1 ? `出口 IP 不稳定（${uniq.join(' → ')}）——同一会话换 IP 极易被判机器人` : '',
  };
}
