import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { getAccessToken } from './oauth.mjs';
import { listRecent, listRecentLegacy, looksOpaque } from './graph.mjs';

/**
 * 邮箱通道：收验证码（IMAP）+ 发信（SMTP）。
 *
 * 为什么要它：DeepSeek 在「陌生设备/高风险」登录时会强制邮箱验证码
 * （biz_code 14 = MFA_VERIFICATION_CODE_REQUIRED）。这一步拿不到码就永远登不进去，
 * 而码只在邮箱里 —— 所以登录自动化必须自带读信能力。
 *
 * 默认按 Gmail 配置（imap.gmail.com / smtp.gmail.com），
 * 用「应用专用密码」，普通密码会被 Google 直接拒绝。
 *
 * 环境变量：
 *   MAIL_IMAP_HOST / MAIL_IMAP_PORT / MAIL_USER / MAIL_PASS / MAIL_MAILBOX
 *   MAIL_SMTP_HOST / MAIL_SMTP_PORT / MAIL_FROM
 *   MAIL_CODE_TIMEOUT_MS（默认 120000）/ MAIL_CODE_REGEX
 */

const DEFAULT_CODE_REGEX = '(?<!\\d)(\\d{6})(?!\\d)';

function pick(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function readMailConfig() {
  const user = pick('MAIL_USER', '');
  const pass = pick('MAIL_PASS', '');
  return {
    user,
    pass,
    imap: {
      host: pick('MAIL_IMAP_HOST', 'imap.gmail.com'),
      port: Number(pick('MAIL_IMAP_PORT', '993')),
      secure: pick('MAIL_IMAP_SECURE', 'true') !== 'false',
      mailbox: pick('MAIL_MAILBOX', 'INBOX'),
    },
    smtp: {
      host: pick('MAIL_SMTP_HOST', 'smtp.gmail.com'),
      port: Number(pick('MAIL_SMTP_PORT', '465')),
      secure: pick('MAIL_SMTP_SECURE', 'true') !== 'false',
    },
    from: pick('MAIL_FROM', user),
    codeTimeoutMs: Number(pick('MAIL_CODE_TIMEOUT_MS', '120000')),
    codeRegex: pick('MAIL_CODE_REGEX', DEFAULT_CODE_REGEX),
    /**
     * 认证方式：
     *   password —— 应用密码 / 授权码（Gmail 仍可用；微软个人账户已废弃）
     *   oauth    —— XOAUTH2（微软 / 企业邮箱，配 client_id + refresh_token）
     */
    oauth: {
      enabled: pick('MAIL_AUTH_MODE', '') === 'oauth' || Boolean(pick('MAIL_OAUTH_REFRESH_TOKEN', '')),
      clientId: pick('MAIL_OAUTH_CLIENT_ID', ''),
      tenant: pick('MAIL_OAUTH_TENANT', 'consumers'),
      refreshToken: pick('MAIL_OAUTH_REFRESH_TOKEN', ''),
      scope: pick('MAIL_OAUTH_SCOPE', 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'),
    },
  };
}

/** 地址归一化：小写、去掉 + 之后的 tag（Outlook 的 + 别名都投同一信箱） */
export function normalizeAddress(addr) {
  return String(addr || '')
    .trim()
    .toLowerCase()
    .replace(/\+[^@]*@/, '@');
}

/**
 * 这封邮件是不是发给 expectTo 的。
 *
 * 必须**先精确匹配完整地址**（含 +tag / 点号）：同一个信箱会收到
 * xingling66666+dsA@ 和 xingling66666+dsB@ 两套验证码，
 * 归一化后一律相等会把别人的码喂进当前注册（实测就是这样混进来的）。
 */
function isAddressedTo(mail, expectTo) {
  const wanted = String(expectTo || '').trim().toLowerCase();
  if (!wanted) return true;

  const list = mail.to || mail.toAddresses || [];
  const flat = Array.isArray(list) ? list : [list];
  const addrs = flat
    .map((t) => (typeof t === 'string' ? t : t?.address || t?.emailAddress?.address || ''))
    .filter(Boolean)
    .map((a) => a.trim().toLowerCase());

  // 1) 精确匹配（含 tag）
  if (addrs.some((a) => a === wanted)) return true;

  // 2) 转发场景：Outlook 自动转发到 Gmail 后，To: 变成了 Gmail 地址，
  //    但原收件人仍会出现在正文/引用头里（或在 Delivered-To）。
  //    所以再在原文里找一次我们要注册的那个地址。
  const raw = String(mail.raw || '').toLowerCase();
  if (raw && raw.includes(wanted)) return true;

  if (!addrs.length) return true; // 拿不到收件人就不拦

  // 3) 只有「我们要注册的就是裸地址」时，才允许把对方的 tag 去掉再比
  const wantHasTag = /\+[^@]*@/.test(wanted);
  if (!wantHasTag) {
    const bare = normalizeAddress(wanted);
    return addrs.some((a) => normalizeAddress(a) === bare);
  }
  return false;
}

export function mailConfigured(cfg = readMailConfig()) {
  if (cfg.oauth?.enabled) {
    return Boolean(cfg.user && cfg.oauth.clientId && cfg.oauth.refreshToken);
  }
  return Boolean(cfg.user && cfg.pass);
}

/** 去掉引用历史：Gmail/Outlook 的回复会带上一封正文，里面是旧验证码 */
function stripQuoted(text) {
  const cutters = [
    /^On .+ wrote:$/m,
    /^-{2,}\s*Original Message\s*-{2,}$/im,
    /^>{2,}/m,
    /^(发件人|寄件者)[:：]/m,
    /^在.+写道[:：]$/m,
    /^From:\s.+\n(Sent|Date|发送时间)[:：]/im,
    /^_{5,}$/m,
  ];
  let out = String(text || '');
  for (const re of cutters) {
    const m = re.exec(out);
    if (m && m.index > 40) out = out.slice(0, m.index);
  }
  return out;
}

/** 去掉 MIME 头，只留正文（之前把头里的编号当成验证码，重复出现同一个"码"就是这个原因） */
function stripHeaders(raw) {
  const text = String(raw || '');
  const idx = text.search(/\r?\n\r?\n/);
  if (idx < 0) return text;
  // 只有确实像邮件头时才截断（避免把普通文本误伤）
  const head = text.slice(0, idx);
  if (!/^(From|To|Subject|Date|Received|DKIM-Signature|Content-Type):/im.test(head)) return text;
  return text.slice(idx);
}

/** 解 quoted-printable（=3D 之类），否则 HTML 里的引号都匹配不上 */
function decodeQp(text) {
  return String(text || '')
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * 从 DeepSeek 的邮件模板里精确取码：真码在 class="code-text" 的容器里。
 * 拿不到再退回关键词/正则。
 */
function codeFromHtmlContainer(raw) {
  const html = decodeQp(String(raw || ''));
  const anchor = /class\s*=\s*["']?code-text["']?/i.exec(html);
  if (!anchor) return null;
  const segment = html.slice(anchor.index, anchor.index + 1200);
  // 数字可能被拆成多个 <div>9</div><div>2</div>…，先去标签再取第一段 4~8 位
  const flat = segment.replace(/<[^>]*>/g, ' ');
  let m = /(?:^|[^\d])(\d{4,8})(?![\d])/.exec(flat);
  if (m) return m[1];
  // 有的模板把每一位拆成单独的 <div>9</div><div>2</div>…
  const joined = flat.replace(/\s+/g, '');
  m = /(?:^|[^\d])(\d{4,8})(?![\d])/.exec(joined);
  return m ? m[1] : null;
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 从一封信里抠出验证码：先按正则，其次按「验证码」关键词附近取 4~8 位数字 */
const CODE_KEYWORDS = [
  '验证码', '校验码', '确认码', '动态码', '安全代码',
  'verification code', 'verify code', 'security code', 'one-time code',
  'one time code', 'login code', 'sign-in code', 'passcode', 'otp', 'code is', 'code:',
];

/** 明显不是验证码的 4~8 位数字（年份、金额、订单号尾部等） */
function looksLikeNoise(num) {
  const n = String(num);
  if (/^(19|20)\d{2}$/.test(n) && n.length === 4) return true; // 年份
  return false;
}

/**
 * 从一封邮件里提验证码。
 *
 * 之前的实现是「整封信里第一个 6 位数字」—— 实测会撞上订单号、追踪号、页脚统计数字，
 * 比如把 213118 当成验证码，而真正的码是 858545。
 *
 * 现在按分数挑：关键词后面紧跟的数字分最高，孤立数字分最低；同分取最先出现的。
 *
 * @returns {{code: string|null, score: number, context: string}}
 */
export function extractCodeDetailed(raw, { regex = DEFAULT_CODE_REGEX } = {}) {
  // 1) 模板容器精确取码（最高优先，实测最可靠）
  const containerCode = codeFromHtmlContainer(raw);
  if (containerCode) return { code: containerCode, score: 200, context: 'code-text 容器' };

  const text = stripQuoted(htmlToText(stripHeaders(raw)));
  if (!text) return { code: null, score: 0, context: '' };

  const candidates = [];

  const push = (code, score, context) => {
    if (!code || looksLikeNoise(code)) return;
    const ctx = String(context || '');
    // 「不是验证码 213118」「not your code」这类否定语境直接压到最低
    const negated = /不是|无需|勿用作|not your|ignore|do not use/i.test(ctx);
    // 同一个数字在信里出现多次（标题+正文）更像真验证码
    let freq = 0;
    try {
      freq = (text.match(new RegExp(`(?<!\\d)${code}(?!\\d)`, 'g')) || []).length;
    } catch {
      freq = 0;
    }
    candidates.push({
      code: String(code),
      score: (negated ? -200 : score) + Math.min(freq - 1, 3) * 5,
      context: ctx.slice(0, 80),
    });
  };

  // 1) 关键词 + 数字（最高分）：验证码是 858545 / your verification code is 858545
  for (const kw of CODE_KEYWORDS) {
    const re = new RegExp(`${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\d]{0,24}(\\d{4,8})(?!\\d)`, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
      // 上下文要带上前面一小段，才能识别「不是验证码 xxx」这种否定
      push(m[1], 100, text.slice(Math.max(0, m.index - 12), m.index + m[0].length));
    }
  }

  // 2) 数字 + 关键词（中英文都有这种语序）：858545 是你的验证码
  {
    const re = /(\d{4,8})(?!\d)[^\d]{0,16}(验证码|校验码|verification code|code)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      push(m[1], 80, text.slice(Math.max(0, m.index - 12), m.index + m[0].length));
    }
  }

  // 3) 一个明显孤立的大号数字（字号/换行隔开）—— 常见于 HTML 模板里单独一行
  {
    const re = /(?:^|\n)\s*(\d{4,8})\s*(?:\n|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) push(m[1], 60, m[0]);
  }

  // 4) 兜底：配置的正则（默认 6 位数字），分数最低
  try {
    const re = new RegExp(regex, 'g');
    let m;
    while ((m = re.exec(text)) !== null) push(m[1] || m[0], 20, text.slice(Math.max(0, m.index - 20), m.index + 12));
  } catch {
    /* 正则写错就跳过 */
  }

  candidates.sort((a, b) => (b.score - a.score) || a.context.length - b.context.length);
  const best = candidates[0];
  return best || { code: null, score: 0, context: '' };
}

export function extractCode(raw, opts = {}) {
  return extractCodeDetailed(raw, opts).code;
}

/**
 * 构造 IMAP 认证对象。
 *
 * 微软个人账户不支持应用密码，必须 XOAUTH2：
 *   auth = { user, accessToken }（ImapFlow 内部走 AUTHENTICATE XOAUTH2）
 * 其它邮箱继续用 LOGIN（应用密码/授权码）。
 */
async function buildImapAuth(cfg, log = () => {}) {
  if (cfg.oauth?.enabled) {
    log('IMAP 认证：XOAUTH2');
    const accessToken = await getAccessToken({
      clientId: cfg.oauth.clientId,
      tenant: cfg.oauth.tenant,
      refreshToken: cfg.oauth.refreshToken,
      scope: cfg.oauth.scope,
      user: cfg.user,
      onRefresh: (next) => {
        log('OAuth refresh_token 已轮换，已保存');
        cfg.oauth.refreshToken = next;
        try {
          cfg.oauth.onRefresh?.(next);
        } catch {
          /* 落库失败不影响本次收信 */
        }
      },
    });
    return { user: cfg.user, accessToken };
  }
  return { user: cfg.user, pass: cfg.pass };
}

/**
 * 收集「发码之后到达」的所有候选验证码，最新优先。
 *
 * 为什么返回列表：同一信箱里可能同时存在两封验证码邮件（平台连发/上次残留），
 * 猜哪个"更新"经常猜错（实测把正确的 340680 换成了旧请求的 471886）。
 * 正确做法是把候选按新→旧交给上层逐个尝试，由服务端判定。
 */
export async function collectCodes({ cfg = readMailConfig(), sinceMs = Date.now() - 60_000, expectTo = '', limit = 3, log = null } = {}) {
  const out = [];
  const seen = new Set();

  const take = (mail) => {
    const tooOld = mail.at < sinceMs - 3000;
    if (tooOld || !isAddressedTo(mail, expectTo)) {
      log?.(
        `跳过邮件（${tooOld ? '早于发码时刻' : '收件人不符'}｜at=${new Date(mail.at).toISOString()}｜since=${new Date(sinceMs).toISOString()}｜"${String(mail.subject).slice(0, 30)}"）`,
      );
      return;
    }
    const d = extractCodeDetailed(mail.text, { regex: cfg.codeRegex });
    if (!d.code || seen.has(d.code)) return;
    seen.add(d.code);
    out.push({ code: d.code, at: mail.at, uid: mail.uid ?? mail.id, subject: mail.subject, score: d.score });
    log?.(`候选 ${d.code}（at=${new Date(mail.at).toISOString()}｜uid=${mail.uid ?? mail.id}｜"${String(mail.subject).slice(0, 30)}"）`);
  };

  // Graph（JWT token）或 Outlook REST（MSA 不透明票据）
  if (cfg.oauth?.enabled && String(cfg.oauth.scope || '').includes('graph.microsoft.com')) {
    const accessToken = await getAccessToken({
      clientId: cfg.oauth.clientId,
      tenant: cfg.oauth.tenant,
      refreshToken: cfg.oauth.refreshToken,
      scope: cfg.oauth.scope,
      user: cfg.user,
    });
    const mails = looksOpaque(accessToken) ? await listRecentLegacy({ accessToken }) : await listRecent({ accessToken });
    for (const m of mails) take({ at: m.at, uid: m.id, subject: m.subject, text: m.text, to: m.to });
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // IMAP
  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: await buildImapAuth(cfg),
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(cfg.imap.mailbox);
    try {
      const uids = await client.search({ since: new Date(sinceMs - 864e5) });
      if (uids?.length) {
        for await (const msg of client.fetch(uids.slice(-25), { uid: true, envelope: true, source: true })) {
          // 没有 INTERNALDATE 时用 Date 头；两者都拿不到就跳过（之前给 Date.now() 会让旧邮件全部混进来）
          let at = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
          if (!at) {
            const hdr = (msg.envelope?.date ? String(msg.envelope.date) : '') || '';
            const t = Date.parse(hdr);
            at = Number.isFinite(t) ? t : 0;
          }
          if (!at) {
            log?.(`跳过邮件（没有可用时间戳｜uid=${msg.uid}）`);
            continue;
          }
          const toAddrs = (msg.envelope?.to || []).map((t) => t.address).filter(Boolean);
          const src = msg.source ? msg.source.toString() : '';
          take({
            at,
            uid: msg.uid,
            subject: msg.envelope?.subject || '',
            text: src,
            to: toAddrs,
            raw: src,
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return out.sort((a, b) => (b.at - a.at) || (b.uid - a.uid)).slice(0, limit);
}

/**
 * 轮询邮箱拿最新的验证码。
 *
 * 只在 sinceMs 之后到达、且主题/正文含 DeepSeek 关键字的信里找，
 * 避免拿到上一封旧码（MFA 码是一次性的，旧码填进去直接失败）。
 */
export async function waitForCode({
  cfg = readMailConfig(),
  sinceMs = Date.now() - 60_000,
  timeoutMs,
  pollMs = 3000,
  subjectHint = /deepseek|deepseek\s*账号|验证/i,
  log = () => {},
  signal,
  /** 本轮已用过的验证码：命中也要跳过（否则会拿上一封的旧码反复试） */
  exclude = null,
  /** 允许的时钟偏差；只接受 sinceMs 之后到达的邮件 */
  skewMs = 10_000,
  /** 期望的收件人：同一信箱会收到多个别名的验证码，必须核对收件人 */
  expectTo = '',
} = {}) {
  if (!mailConfigured(cfg)) {
    throw new Error('邮箱未配置：请设置 MAIL_USER / MAIL_PASS（Gmail 需应用专用密码）');
  }
  const deadline = Date.now() + (timeoutMs ?? cfg.codeTimeoutMs); // 复查时会传 2000
  const seen = new Set();
  let lastError = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('邮箱轮询已取消');
    // OAuth + Graph scope：不碰 IMAP，直接走 REST
    // 只有 scope 真的要 Graph 且 token 是 JWT 才走 Graph；MSA 不透明票据走 IMAP/legacy
    if (cfg.oauth?.enabled && String(cfg.oauth.scope || '').includes('graph.microsoft.com')) {
      try {
        const accessToken = await getAccessToken({
          clientId: cfg.oauth.clientId,
          tenant: cfg.oauth.tenant,
          refreshToken: cfg.oauth.refreshToken,
          scope: cfg.oauth.scope,
          user: cfg.user,
          onRefresh: (next) => {
            cfg.oauth.refreshToken = next;
            try { cfg.oauth.onRefresh?.(next); } catch {}
          },
        });
        let mails;
        if (looksOpaque(accessToken)) {
          // MSA 不透明票据：Graph 一定 401，直接走 Outlook REST
          log('token 是 MSA 票据，改用 Outlook REST 读信');
          mails = await listRecentLegacy({ accessToken });
        } else {
          try {
            mails = await listRecent({ accessToken, folder: cfg.imap?.mailbox?.toLowerCase() === 'inbox' ? 'inbox' : cfg.imap.mailbox });
          } catch (err) {
            if (err.status !== 401) throw err;
            log('Graph 401，回退 Outlook REST');
            mails = await listRecentLegacy({ accessToken });
          }
        }
        for (const mail of mails) {
          if (mail.at < sinceMs - skewMs) continue;
          if (!isAddressedTo(mail, expectTo)) {
            log(`跳过：收件人不匹配（${(mail.to || []).join(',') || '未知'} ≠ ${expectTo}）`);
            continue;
          }
          if (!subjectHint.test(mail.subject) && !subjectHint.test(mail.text.slice(0, 4000))) continue;
          const detail = extractCodeDetailed(mail.text, { regex: cfg.codeRegex });
          if (detail.code && exclude?.has?.(detail.code)) {
            log(`跳过已用过的验证码 ${detail.code}（等新码）`);
            continue;
          }
          if (detail.code) {
            log(
              `Graph 命中验证码 ${detail.code}（分 ${detail.score}｜${mail.receivedDateTime}｜主题="${mail.subject}"｜上下文「${detail.context}」）`,
            );
            return { code: detail.code, subject: mail.subject, uid: mail.id, at: Date.now(), via: 'graph' };
          }
        }
      } catch (err) {
        lastError = err;
        log(`Graph 收信失败（${err.message}），${pollMs}ms 后重试`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }

    const auth = await buildImapAuth(cfg, log);
    const client = new ImapFlow({
      host: cfg.imap.host,
      port: cfg.imap.port,
      secure: cfg.imap.secure,
      auth,
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(cfg.imap.mailbox);
      try {
        const since = new Date(sinceMs - 60_000);
        const uids = await client.search({ since });
        if (uids?.length) {
          // 先收集候选，再**按 uid 倒序**取最新的：升序遍历会先命中旧邮件里的旧码
          const hits = [];
          for await (const msg of client.fetch(uids.slice(-20), { uid: true, envelope: true, source: true })) {
            const key = `${msg.uid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const subject = msg.envelope?.subject || '';
            const from = msg.envelope?.from?.[0]?.address || '';
            const source = msg.source ? msg.source.toString() : '';
            const looksFromDs = /deepseek/i.test(subject) || /deepseek/i.test(from);
            if (!looksFromDs && !subjectHint.test(subject) && !subjectHint.test(source.slice(0, 4000))) continue;
            const receivedAt = msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now();
            if (receivedAt < sinceMs - skewMs) continue;
            const toAddrs = (msg.envelope?.to || []).map((t) => t.address).filter(Boolean);
            if (!isAddressedTo({ to: toAddrs }, expectTo)) {
              log(`跳过：收件人不匹配（${toAddrs.join(',') || '未知'} ≠ ${expectTo}）`);
              continue;
            }
            const detail = extractCodeDetailed(source, { regex: cfg.codeRegex });
            if (!detail.code) continue;
            if (exclude?.has?.(detail.code)) {
              log(`跳过已用过的验证码 ${detail.code}（等新码）`);
              continue;
            }
            hits.push({
              code: detail.code,
              subject,
              uid: msg.uid,
              at: Date.now(),
              score: detail.score + (looksFromDs ? 30 : 0),
              context: detail.context,
            });
          }
          if (hits.length) {
            // 最新优先；同一封里分数都一样，用 uid 定序
            hits.sort((a, b) => b.uid - a.uid || b.score - a.score);
            const best = hits[0];
            log(
              `邮箱命中验证码 ${best.code}（uid=${best.uid}｜主题="${best.subject}"｜上下文「${best.context}」）`,
            );
            return { code: best.code, subject: best.subject, uid: best.uid, at: best.at };
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      lastError = err;
      log(`收信失败（${err.message}），${pollMs}ms 后重试`);
    } finally {
      await client.logout().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`等验证码超时${lastError ? `：${lastError.message}` : ''}`);
}

/** SMTP 发一封信（自测 / 告警用；登录流程本身不需要发信） */
export async function sendMail({ cfg = readMailConfig(), to, subject, text, html }, log = () => {}) {
  if (!mailConfigured(cfg)) throw new Error('邮箱未配置：请设置 MAIL_USER / MAIL_PASS');
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  const info = await transport.sendMail({ from: cfg.from, to, subject, text, html });
  log(`邮件已发送 messageId=${info.messageId}`);
  return info;
}
