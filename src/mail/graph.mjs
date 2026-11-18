/**
 * 用 Microsoft Graph 读验证码（替代 IMAP）。
 *
 * 为什么不让个人账户走 IMAP：outlook.com 的 IMAP 需要邮箱侧「允许设备和应用使用 IMAP」打开，
 * 而且 IMAP 的 XOAUTH2 票据类型（MSA 不透明票据）经常被 Exchange 判成
 * "User is authenticated but not connected."。Graph 走的是 REST，同一个 OAuth 授权就能用，
 * 不依赖 IMAP 开关。
 *
 * 所需 scope：`https://graph.microsoft.com/Mail.Read offline_access`
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

export const GRAPH_SCOPE = 'https://graph.microsoft.com/Mail.Read offline_access';

async function graphGet(path, accessToken) {
  const res = await fetch(`${GRAPH}${path}`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Graph HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code || `http_${res.status}`;
    throw err;
  }
  return json;
}

/** 拉最近若干封邮件（默认收件箱） */
export async function listRecent({ accessToken, top = 15, folder = 'inbox' }) {
  const select = 'subject,receivedDateTime,bodyPreview,body,from,toRecipients,isRead';
  const data = await graphGet(
    `/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime desc`,
    accessToken,
  );
  return (data.value || []).map((m) => ({
    id: m.id,
    subject: m.subject || '',
    from: m.from?.emailAddress?.address || '',
    to: (m.toRecipients || []).map((r) => r.emailAddress?.address).filter(Boolean),
    receivedDateTime: m.receivedDateTime,
    at: Date.parse(m.receivedDateTime) || 0,
    text: `${m.subject || ''}\n${m.bodyPreview || ''}\n${stripHtml(m.body?.content || '')}`,
  }));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

/** 校验 token 能不能读信（诊断用） */
export async function probeGraph(accessToken) {
  const data = await graphGet('/me?$select=displayName,mail,userPrincipalName', accessToken);
  return { displayName: data.displayName, mail: data.mail, upn: data.userPrincipalName };
}


/* -------------------------------------------------------------------------- *
 * Outlook legacy REST（outlook.office.com/api/v2.0）
 *
 * 个人 Microsoft 账户在旧版公共客户端下拿到的是 MSA 不透明票据（形如 EwB...），
 * graph.microsoft.com 直接 401，但 Outlook REST 认这种票据。
 * 所以收码实现两条腿：Graph 优先，401 就用 legacy REST。
 * -------------------------------------------------------------------------- */

const LEGACY = 'https://outlook.office.com/api/v2.0';

export function looksOpaque(token) {
  return !String(token || '').includes('.');
}

async function legacyGet(path, accessToken) {
  const res = await fetch(`${LEGACY}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      // 新版端点要求显式声明兼容
      'X-AnchorMailbox': 'me',
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Outlook REST HTTP ${res.status}`);
    err.status = res.status;
    err.code = json?.error?.code || `http_${res.status}`;
    throw err;
  }
  return json;
}

/** 拉最近邮件（legacy REST） */
export async function listRecentLegacy({ accessToken, top = 15 }) {
  const select = 'Subject,ReceivedDateTime,BodyPreview,Body,From,ToRecipients';
  const data = await legacyGet(
    `/me/messages?$top=${top}&$select=${select}&$orderby=ReceivedDateTime desc`,
    accessToken,
  );
  return (data.value || []).map((m) => ({
    id: m.Id,
    subject: m.Subject || '',
    from: m.From?.EmailAddress?.Address || '',
    to: (m.ToRecipients || []).map((r) => r.EmailAddress?.Address).filter(Boolean),
    receivedDateTime: m.ReceivedDateTime,
    at: Date.parse(m.ReceivedDateTime) || 0,
    text: `${m.Subject || ''}\n${m.BodyPreview || ''}\n${stripHtml(m.Body?.Content || '')}`,
  }));
}
