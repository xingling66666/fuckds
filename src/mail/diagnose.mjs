/**
 * 邮箱收信诊断：把「为什么连不上」讲清楚。
 *
 * 只做只读操作（connect → 列出最近几封），不删除、不标记已读。
 */

import { ImapFlow } from 'imapflow';
import { getAccessToken, describeToken } from './oauth.mjs';
import { probeGraph, listRecent, listRecentLegacy, looksOpaque } from './graph.mjs';

/** 解出 JWT 的 payload（不验签，只为看 aud/scp/exp） */
export function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1];
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * @param {object} cfg 与 mailbox.readMailConfig 同结构
 * @returns {Promise<{ok:boolean, stage:string, host:string, authMode:string, token?:object, error?:string, detail?:object, mails?:object[]}>}
 */
export async function testMailbox(cfg, log = () => {}) {
  const authMode = cfg.oauth?.enabled ? 'oauth' : 'password';
  const result = { ok: false, stage: 'init', host: cfg.imap?.host || '', authMode, user: cfg.user || '' };

  let auth;
  try {
    result.stage = 'token';
    if (authMode === 'oauth') {
      const accessToken = await getAccessToken({
        clientId: cfg.oauth.clientId,
        tenant: cfg.oauth.tenant,
        refreshToken: cfg.oauth.refreshToken,
        scope: cfg.oauth.scope,
        user: cfg.user,
      });
      result.token = decodeJwt(accessToken) || describeToken(accessToken);
      auth = { user: cfg.user, accessToken };
      result.__token = accessToken;
    } else {
      auth = { user: cfg.user, pass: cfg.pass };
    }
  } catch (err) {
    result.stage = 'token';
    result.error = `拿 access_token 失败：${err.message}`;
    return result;
  }

  // Graph 模式：探 /me + 拉最近几封
  if (authMode === 'oauth' && String(cfg.oauth.scope || '').includes('graph.microsoft.com')) {
    try {
      result.stage = 'graph';
      const accessToken = result.__token;
      let me = null;
      let mails = [];
      let via = 'graph';
      if (looksOpaque(accessToken)) {
        via = 'outlook-rest';
        result.note = 'MSA 不透明票据：Graph 不可用，改用 Outlook REST';
        mails = await listRecentLegacy({ accessToken });
      } else {
        try {
          me = await probeGraph(accessToken);
          mails = await listRecent({ accessToken, folder: 'inbox' });
        } catch (err) {
          if (err.status !== 401) throw err;
          via = 'outlook-rest';
          result.note = 'Graph 401，回退 Outlook REST';
          mails = await listRecentLegacy({ accessToken });
        }
      }
      result.via = via;
      result.account = me;
      result.mails = mails.slice(0, 5).map((m) => ({ subject: m.subject, from: m.from, at: m.receivedDateTime }));
      result.ok = true;
      result.stage = 'done';
      return result;
    } catch (err) {
      result.error =
        err.status === 401
          ? `Graph 401：token 不是给 Graph 的（aud=${describeToken(result.__token).aud || '不透明票据'}）——请重新授权一次，scope 应为 graph.microsoft.com/Mail.Read`
          : `Graph：${err.message}`;
      result.detail = { code: err.code, status: err.status, token: describeToken(result.__token) };
      return result;
    }
  }

  const client = new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth,
    logger: false,
  });

  try {
    result.stage = 'connect';
    await client.connect();
    result.stage = 'mailbox';
    const lock = await client.getMailboxLock(cfg.imap.mailbox);
    const mails = [];
    try {
      const uids = await client.search({ since: new Date(Date.now() - 7 * 864e5) });
      const take = (uids || []).slice(-5);
      if (take.length) {
        for await (const msg of client.fetch(take, { uid: true, envelope: true })) {
          mails.push({ uid: msg.uid, subject: msg.envelope?.subject || '', from: msg.envelope?.from?.[0]?.address || '' });
        }
      }
    } finally {
      lock.release();
    }
    result.mails = mails;
    result.ok = true;
    result.stage = 'done';
    return result;
  } catch (err) {
    result.error = `${String(err.message || err)}${err.responseText ? ` | ${err.responseText}` : ''}`;
    result.detail = {
      code: err.code,
      authenticationFailed: err.authenticationFailed,
      serverResponseCode: err.serverResponseCode,
      responseText: err.responseText,
    };
    return result;
  } finally {
    await client.logout().catch(() => {});
  }
}
