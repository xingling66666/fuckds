import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { adminApi } from '../api.js';
import {
  Banner,
  Btn,
  Card,
  Chip,
  ErrorBanner,
  Select,
  Stat,
  TextField,
  Toggle,
  toast,
} from '../ui.jsx';

const MASK = '***';

const STATE_LABEL = {
  idle: '空闲',
  running: '进行中',
  done: '已完成',
  failed: '失败',
};

const STATE_TONE = {
  idle: 'neutral',
  running: 'info',
  done: 'success',
  failed: 'danger',
};

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds(),
  ).padStart(2, '0')}`;
}

function fmtAgo(ts) {
  if (!ts) return '从未';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  return `${Math.round(s / 3600)} 小时前`;
}

export default function Register() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [sched, setSched] = useState({});
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [solverCount, setSolverCount] = useState(null);
  const [mode, setMode] = useState('auto');
  const [codeInput, setCodeInput] = useState('');
  const [proxyTest, setProxyTest] = useState(null);
  const [oauthInfo, setOauthInfo] = useState(null);
  const [mailTest, setMailTest] = useState(null);
  const logRef = useRef(null);

  const load = useCallback(async (silent = false) => {
    try {
      const [res, accounts] = await Promise.all([
        adminApi('/register/auto'),
        adminApi('/accounts').catch(() => null),
      ]);
      if (accounts?.poolCounts) setSolverCount(accounts.poolCounts.solver ?? 0);
      setData(res);
      // 正在跑时，收码方式跟随实际运行的模式（避免显示和实际不一致）
      if (res?.status?.running && res.status.mode) setMode(res.status.mode);
      setError('');
      if (!silent) {
        setDraft((prev) => ({ ...prev, ...(res.settings || {}) }));
        setSched({
          enabled: res.settings?.enabled ?? false,
          windowStart: res.settings?.windowStart ?? '00:00',
          windowEnd: res.settings?.windowEnd ?? '23:59',
          intervalMin: res.settings?.intervalMin ?? 10,
          dailyMax: res.settings?.dailyMax ?? 5,
        });
      }
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => load(true), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const status = data?.status;
  const running = Boolean(status?.running);
  const settings = data?.settings || {};

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [status?.logs?.length]);

  const saveMail = async () => {
    setBusy('mail');
    try {
      const payload = {};
      for (const key of ['emailBase', 'emailDomain', 'imapHost', 'imapPort', 'imapUser', 'mailbox', 'imapAuthMode', 'oauthPreset', 'oauthClientId', 'oauthTenant']) {
        if (draft[key] !== undefined) payload[key] = draft[key];
      }
      if (draft.password && draft.password !== MASK) payload.password = draft.password;
      if (draft.imapPass && draft.imapPass !== MASK) payload.imapPass = draft.imapPass;
      await adminApi('/register/auto/config', { method: 'POST', body: payload });
      toast('邮箱配置已保存');
      await load();
    } catch (err) {
      toast(`保存失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const saveSchedule = async () => {
    setBusy('sched');
    try {
      await adminApi('/register/auto/config', {
        method: 'POST',
        body: {
          windowStart: sched.windowStart,
          windowEnd: sched.windowEnd,
          intervalMin: Number(sched.intervalMin) || 10,
          dailyMax: Number(sched.dailyMax) || 5,
        },
      });
      toast('定时配置已保存');
      await load();
    } catch (err) {
      toast(`保存失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const toggleScheduler = async (enabled) => {
    setBusy('toggle');
    try {
      const res = await adminApi('/register/auto/scheduler', { method: 'POST', body: { enabled } });
      setSched((prev) => ({ ...prev, enabled }));
      toast(enabled ? '定时注册已开启' : '定时注册已关闭');
      if (!res.schedulerRunning && enabled) toast('调度器未启动，检查服务日志');
      await load();
    } catch (err) {
      toast(`操作失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const runOnce = async () => {
    setBusy('run');
    try {
      await adminApi('/register/auto/run', { method: 'POST', body: { email: email.trim(), mode } });
      toast(mode === 'manual' ? '已开始注册，等验证码到了在上面填' : '已开始注册，稍候看进度');
      await load(true);
    } catch (err) {
      toast(`启动失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const saveProxy = async () => {
    setBusy('proxy-save');
    try {
      const res = await adminApi('/register/auto/config', { method: 'POST', body: { proxy: draft.proxy || '' } });
      toast(res?.settings?.proxy ? `代理已保存：${res.settings.proxy}` : '已清空代理（走直连）');
      await load();
    } catch (err) {
      toast(`保存失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const runMailTest = async () => {
    setBusy('mailtest');
    setMailTest(null);
    try {
      const res = await adminApi('/mail/test', { method: 'POST', body: {} });
      setMailTest(res);
      toast(res.ok ? `收信正常，最近 ${res.mails?.length ?? 0} 封` : `收信失败：${res.error}`);
    } catch (err) {
      setMailTest({ ok: false, error: err.message });
      toast(`测试失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const startOAuth = async () => {
    setBusy('oauth');
    setOauthInfo(null);
    try {
      const res = await adminApi('/mail/oauth/start', {
        method: 'POST',
        body: { preset: draft.oauthPreset || 'thunderbird', clientId: draft.oauthClientId || '', tenant: draft.oauthTenant || '' },
      });
      setOauthInfo({ ...res, done: false });
      toast(`去 ${res.verificationUri} 输入 ${res.userCode}`);
      pollOAuth(res);
    } catch (err) {
      setOauthInfo({ error: err.message });
      toast(`授权启动失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const pollOAuth = (info) => {
    const deadline = Date.now() + (info.expiresIn || 900) * 1000;
    let interval = Math.max(2, info.interval || 5) * 1000;
    const tick = async () => {
      if (Date.now() > deadline) {
        setOauthInfo((prev) => ({ ...prev, error: '设备码已过期，请重新开始授权' }));
        return;
      }
      try {
        const res = await adminApi('/mail/oauth/poll', {
          method: 'POST',
          body: { preset: info.preset, clientId: info.clientId, tenant: info.tenant, deviceCode: info.deviceCode },
        });
        if (res.pending) {
          if (res.slowDown) interval += 2000;
          setTimeout(tick, interval);
          return;
        }
        setOauthInfo((prev) => ({ ...prev, done: true, userCode: '' }));
        toast('OAuth 授权成功，refresh_token 已保存');
        await load();
      } catch (err) {
        setOauthInfo((prev) => ({ ...prev, error: err.message }));
      }
    };
    setTimeout(tick, interval);
  };

  const testProxy = async () => {
    setBusy('proxy');
    setProxyTest(null);
    try {
      const res = await adminApi('/proxy/test', { method: 'POST', body: { proxy: draft.proxy || '' } });
      setProxyTest(res);
      if (res.ok) {
        // 测通就顺手保存并生效，避免「测了以为生效、实际还在直连」
        try {
          await adminApi('/register/auto/config', { method: 'POST', body: { proxy: draft.proxy || '' } });
          await load(true);
          toast(`代理可用（${res.ip} · ${res.country}），已自动保存并生效`);
        } catch (err) {
          toast(`代理可用，但保存失败：${err.message}`);
        }
      } else {
        toast(`代理不可用：${res.error}`);
      }
    } catch (err) {
      setProxyTest({ ok: false, error: err.message });
      toast(`测试失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const submitCode = async () => {
    setBusy('code');
    try {
      await adminApi('/register/auto/code', { method: 'POST', body: { code: codeInput.trim() } });
      toast('验证码已提交');
      setCodeInput('');
      await load(true);
    } catch (err) {
      toast(`提交失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const stopAll = async () => {
    setBusy('stop');
    try {
      await adminApi('/register/auto/stop', { method: 'POST', body: {} });
      toast('已停止定时注册');
      setSched((prev) => ({ ...prev, enabled: false }));
      await load();
    } catch (err) {
      toast(`操作失败：${err.message}`);
    } finally {
      setBusy('');
    }
  };

  const logs = status?.logs || [];
  const results = status?.results || [];
  const nextRunHint = useMemo(() => {
    const s = status?.scheduler;
    if (!s) return '';
    if (!s.enabled) return '定时未开启';
    if (!s.inWindow) return `不在时段内（${s.windowStart} ~ ${s.windowEnd}）`;
    if (s.today >= s.dailyMax) return `今日已达上限 ${s.dailyMax}`;
    if (!s.lastRunAt) return '满足条件后将立即开始';
    const next = s.lastRunAt + s.intervalMin * 60_000;
    const wait = Math.round((next - Date.now()) / 60_000);
    return wait > 0 ? `约 ${wait} 分钟后下一次` : '随时可开始';
  }, [status]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>注册</h1>
          <p className="muted">一键自动注册新号：自动过 hCaptcha、IMAP 收码、入号池；支持时段定时</p>
        </div>
      </div>
      {error ? <ErrorBanner message={error} onRetry={() => load()} /> : null}

      <Card
        title="一键注册"
        subtitle="自动完成：过 WAF → 填表 → 过 hCaptcha（无障碍题）→ 发码 → IMAP 收码 → 提交 → 入池"
        actions={
          <div className="row gap">
            <Btn
              variant="filled"
              icon="person_add"
              disabled={busy === 'run' || running || solverCount === 0}
              onClick={runOnce}
              loading={busy === 'run'}
            >
              立即注册一次
            </Btn>
            <Btn icon="stop_circle" variant="text" disabled={busy === 'stop' || !running} onClick={stopAll}>
              停止调度
            </Btn>
          </div>
        }
      >
        {solverCount === 0 ? (
          <Banner tone="warn" icon="key">
            解题号池为空。过人机验证只消耗「解题池」里的号（它不参与业务请求，不会被封），请到
            <b>账号</b>页把一个号移到「解题池」后再点注册。
          </Banner>
        ) : null}
        <div className="row gap wrap">
          <Chip tone={STATE_TONE[status?.state] || 'neutral'}>
            {STATE_LABEL[status?.state] || '未知'} · {status?.step || '—'}
          </Chip>
          {running ? <Chip tone="info">已运行 {Math.round((status?.elapsedMs || 0) / 1000)}s</Chip> : null}
          {status?.email ? <Chip title={status.email}>当前：{status.email}</Chip> : null}
          {status?.scheduler?.today !== undefined ? (
            <Chip tone="neutral">
              今日 {status.scheduler.today} / {status.scheduler.dailyMax}
            </Chip>
          ) : null}
          <Chip tone="neutral" title="每次注册随机抽取一台真机（Android / iOS / Windows / Linux）">
            指纹 {status?.profile || '随机'} · {data?.fingerprints?.length ?? 0} 套机型
          </Chip>
          <Chip tone={solverCount ? 'info' : 'danger'}>解题池 {solverCount ?? '—'} 个号</Chip>
          <Chip tone="neutral">下次：{nextRunHint}</Chip>
        </div>

        <div className="row gap wrap" style={{ marginTop: 12 }}>
          <Select
            label="收码方式"
            value={mode}
            onChange={setMode}
            options={[
              { label: '自动收码（IMAP，需应用密码）', value: 'auto' },
              { label: '手动填码（我收到码后填进来）', value: 'manual' },
            ]}
          />
          <TextField
            label="指定邮箱（留空则按时间戳自动生成别名）"
            value={email}
            onChange={setEmail}
            placeholder={settings.emailBase ? `${settings.emailBase}+ds<时间戳>@${settings.emailDomain}` : '前缀@域名'}
            style={{ flex: 1 }}
          />
        </div>

        <div className="row gap wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <TextField
            label="代理（可选，支持 http:// 与 socks5://）"
            value={draft.proxy || ''}
            onChange={(v) => setDraft((p) => ({ ...p, proxy: v }))}
            placeholder="http://127.0.0.1:7890 或 socks5://host:1080（留空=直连）"
            helper="不写协议时按端口猜：1080/1081 走 socks5，其余走 http。改完点右边「保存代理」"
            style={{ flex: 1, minWidth: 320 }}
          />
          <Btn variant="tonal" icon="lan" loading={busy === 'proxy'} disabled={busy === 'proxy'} onClick={testProxy}>
            测试代理
          </Btn>
          <Btn variant="tonal" icon="save" loading={busy === 'proxy-save'} disabled={busy === 'proxy-save'} onClick={saveProxy}>
            保存代理
          </Btn>
        </div>
        {proxyTest ? (
          <div style={{ marginTop: 8 }}>
            {proxyTest.ok ? (
              <Chip tone="success" title={proxyTest.org}>
                代理可用 · {proxyTest.ip} · {proxyTest.country}/{proxyTest.city} · {proxyTest.ms}ms · {proxyTest.scheme}
              </Chip>
            ) : (
              <Chip tone="danger" title={proxyTest.error}>
                不可用：{String(proxyTest.error || '').slice(0, 60)}
              </Chip>
            )}
            {proxyTest.warning ? (
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                ⚠️ {proxyTest.warning}
              </div>
            ) : null}
          </div>
        ) : null}

        {status?.awaitingCode ? (
          <Banner tone="info" icon="sms">
            验证码已发出（<b>{status.email}</b>），把它填到下面这个框里：
            <div className="row gap" style={{ marginTop: 8 }}>
              <TextField
                label="邮箱验证码"
                value={codeInput}
                onChange={setCodeInput}
                placeholder="6 位数字"
                style={{ maxWidth: 220 }}
              />
              <Btn
                variant="filled"
                icon="check"
                disabled={busy === 'code' || !/^\d{4,8}$/.test(codeInput.trim())}
                loading={busy === 'code'}
                onClick={submitCode}
              >
                提交验证码
              </Btn>
            </div>
          </Banner>
        ) : null}

        <div className="register-log" ref={logRef}>
          {logs.length === 0 ? (
            <div className="muted">暂无日志</div>
          ) : (
            logs.map((item, i) => (
              <div key={`${item.at}-${i}`} className="register-log-line">
                <span className="muted mono">{fmtTime(item.at)}</span>
                <span>{item.line}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card
        title="邮箱与收码（IMAP）"
        subtitle="验证码由 IMAP 自动读取：Gmail 用应用专用密码；微软个人账户已废弃应用密码，请选 OAuth2"
        actions={
          <Btn variant="tonal" icon="save" onClick={saveMail} loading={busy === 'mail'} disabled={busy === 'mail'}>
            保存
          </Btn>
        }
      >
        <div className="grid-2">
          <TextField
            label="邮箱前缀"
            value={draft.emailBase || ''}
            onChange={(v) => setDraft((p) => ({ ...p, emailBase: v }))}
            placeholder="例如 xingling9464"
          />
          <TextField
            label="邮箱域名"
            value={draft.emailDomain || ''}
            onChange={(v) => setDraft((p) => ({ ...p, emailDomain: v }))}
            placeholder="outlook.com"
          />
          <TextField
            label="注册密码"
            type="password"
            value={draft.password || ''}
            onChange={(v) => setDraft((p) => ({ ...p, password: v }))}
            placeholder={settings.password === MASK ? '已设置，留空不改' : '至少 8 位'}
          />
          <TextField
            label="IMAP 主机"
            value={draft.imapHost || ''}
            onChange={(v) => setDraft((p) => ({ ...p, imapHost: v }))}
            placeholder="imap.outlook.com"
          />
          <TextField
            label="IMAP 端口"
            type="number"
            value={draft.imapPort || ''}
            onChange={(v) => setDraft((p) => ({ ...p, imapPort: v }))}
            placeholder="993"
          />
          <TextField
            label="IMAP 账号"
            value={draft.imapUser || ''}
            onChange={(v) => setDraft((p) => ({ ...p, imapUser: v }))}
            placeholder="与注册邮箱同一个地址"
          />
          <TextField
            label="IMAP 应用密码 / 授权码"
            type="password"
            value={draft.imapPass || ''}
            onChange={(v) => setDraft((p) => ({ ...p, imapPass: v }))}
            placeholder={settings.imapPass === MASK ? '已设置，留空不改' : '应用密码，不是登录密码'}
          />
          <TextField
            label="收件箱文件夹"
            value={draft.mailbox || ''}
            onChange={(v) => setDraft((p) => ({ ...p, mailbox: v }))}
            placeholder="INBOX"
          />
          <Select
            label="认证方式"
            value={draft.imapAuthMode || 'password'}
            onChange={(v) => setDraft((p) => ({ ...p, imapAuthMode: v }))}
            options={[
              { label: '应用密码 / 授权码（Gmail 等）', value: 'password' },
              { label: 'OAuth2 · XOAUTH2（微软个人账户必选）', value: 'oauth' },
            ]}
          />
          {(draft.imapAuthMode || 'password') === 'oauth' ? (
            <>
              <Select
                label="OAuth 客户端"
                value={draft.oauthPreset || 'thunderbird'}
                onChange={(v) => setDraft((p) => ({ ...p, oauthPreset: v }))}
                options={(data?.oauthPresets || []).map((p) => ({ label: p.label, value: p.id }))}
              />
              {(draft.oauthPreset || 'thunderbird') === 'custom' ? (
                <TextField
                  label="OAuth client_id（你自己的 Azure 应用）"
                  value={draft.oauthClientId || ''}
                  onChange={(v) => setDraft((p) => ({ ...p, oauthClientId: v }))}
                  placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  helper="Azure 需要先有目录：加入 M365 开发者计划或注册 Azure 后才给；应用注册里要打开「允许公共客户端流」"
                />
              ) : null}
              <TextField
                label="OAuth tenant"
                value={draft.oauthTenant || ''}
                onChange={(v) => setDraft((p) => ({ ...p, oauthTenant: v }))}
                placeholder="consumers"
                helper="个人账户用 consumers；企业账户用租户 ID 或 organizations"
              />
            </>
          ) : null}
        </div>

        <div className="row gap wrap" style={{ marginTop: 12 }}>
          <Btn variant="outlined" icon="mark_email_read" onClick={runMailTest} loading={busy === 'mailtest'} disabled={busy === 'mailtest'}>
            测试收信
          </Btn>
          {mailTest?.ok ? (
            <Chip tone="success">
              收信正常 · {mailTest.authMode} · 最近 {mailTest.mails?.length ?? 0} 封
            </Chip>
          ) : null}
          {mailTest && !mailTest.ok ? (
            <Chip tone="danger" title={JSON.stringify(mailTest.detail || {})}>
              {mailTest.stage}：{String(mailTest.error || '').slice(0, 70)}
            </Chip>
          ) : null}
        </div>
        {mailTest?.token ? (
          <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            token aud={mailTest.token.aud} scp={mailTest.token.scp || '(无)'}
          </div>
        ) : null}

        {(draft.imapAuthMode || 'password') === 'oauth' ? (
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row gap wrap">
              <Btn variant="outlined" icon="link" onClick={startOAuth} loading={busy === 'oauth'} disabled={busy === 'oauth'}>
                开始 OAuth 授权
              </Btn>
              {oauthInfo?.userCode ? (
                <Chip tone="info" title={oauthInfo.message || ''}>
                  去 {oauthInfo.verificationUri} 输入：{oauthInfo.userCode}
                </Chip>
              ) : null}
              {oauthInfo?.done ? <Chip tone="success">已授权，refresh_token 已保存</Chip> : null}
              {oauthInfo?.error ? <Chip tone="danger">{oauthInfo.error}</Chip> : null}
              {settings.oauthRefreshToken === MASK ? <Chip tone="success">已有 refresh_token</Chip> : null}
            </div>
            {oauthInfo?.userCode ? (
              <div className="muted" style={{ fontSize: 12.5 }}>
                在浏览器打开 <a href={oauthInfo.verificationUri} target="_blank" rel="noreferrer">{oauthInfo.verificationUri}</a>
                ，输入上面的代码并同意授权；页面会每 {oauthInfo.interval || 5} 秒自动检查一次。
              </div>
            ) : null}
          </div>
        ) : null}
        {!settings.imapConfigured && mode === 'auto' ? (
          <Banner tone="warn" icon="warning">
            还没配置 IMAP —— 不开 IMAP 就只能用「手动填码」模式。
            <br />
            微软个人账户（outlook / hotmail / live）<b>已废弃应用密码</b>，认证方式请选 <b>OAuth2</b>。
            OAuth 客户端选「内置 · Thunderbird」即可，<b>不需要 Azure 订阅、也不用注册应用</b>。
            <br />
            收码走 <b>Microsoft Graph</b>（不依赖 IMAP 开关）；点「开始 OAuth 授权」后去
            microsoft.com/link 输码同意，回来点「测试收信」验证。
          </Banner>
        ) : null}
      </Card>

      <Card
        title="定时自动注册"
        subtitle="只在时段内、按间隔、不超过每日上限时触发；两个号之间至少间隔 1 分钟（发码频率限制）"
        actions={
          <Btn variant="tonal" icon="save" onClick={saveSchedule} loading={busy === 'sched'} disabled={busy === 'sched'}>
            保存时段
          </Btn>
        }
      >
        <div className="row gap wrap" style={{ marginBottom: 12 }}>
          <Toggle
            checked={Boolean(sched.enabled)}
            disabled={busy === 'toggle'}
            onChange={(v) => toggleScheduler(v)}
          />
          <span>{sched.enabled ? '定时注册已开启' : '定时注册已关闭'}</span>
          {status?.scheduler?.lastError ? (
            <Chip tone="danger" title={status.scheduler.lastError}>
              上次错误：{String(status.scheduler.lastError).slice(0, 40)}
            </Chip>
          ) : null}
        </div>
        <div className="grid-4">
          <TextField
            label="开始时间"
            value={sched.windowStart || ''}
            onChange={(v) => setSched((p) => ({ ...p, windowStart: v }))}
            placeholder="09:00"
          />
          <TextField
            label="结束时间"
            value={sched.windowEnd || ''}
            onChange={(v) => setSched((p) => ({ ...p, windowEnd: v }))}
            placeholder="23:00"
          />
          <TextField
            label="间隔（分钟）"
            type="number"
            value={sched.intervalMin ?? ''}
            onChange={(v) => setSched((p) => ({ ...p, intervalMin: v }))}
            placeholder="10"
          />
          <TextField
            label="每日上限"
            type="number"
            value={sched.dailyMax ?? ''}
            onChange={(v) => setSched((p) => ({ ...p, dailyMax: v }))}
            placeholder="5"
          />
        </div>
        <div className="row gap wrap" style={{ marginTop: 12 }}>
          <Stat label="今日已注册" value={status?.scheduler?.today ?? 0} hint={`上限 ${status?.scheduler?.dailyMax ?? '—'}`} />
          <Stat label="上次运行" value={fmtAgo(status?.scheduler?.lastRunAt)} hint="成功或失败都会记录" />
          <Stat
            label="时段"
            value={`${status?.scheduler?.windowStart ?? '—'} ~ ${status?.scheduler?.windowEnd ?? '—'}`}
            hint={status?.scheduler?.inWindow ? '当前在时段内' : '当前不在时段内'}
            tone={status?.scheduler?.inWindow ? 'success' : 'neutral'}
          />
        </div>
      </Card>

      <Card title="注册记录" subtitle="最近 15 条（token 只显示前 10 位）">
        {results.length === 0 ? (
          <div className="muted">还没有记录</div>
        ) : (
          <div className="table">
            <div className="table-row table-head">
              <span>时间</span>
              <span>邮箱</span>
              <span>结果</span>
              <span>Token</span>
            </div>
            {results.map((item, i) => (
              <div key={`${item.at}-${i}`} className="table-row">
                <span className="mono muted">{fmtTime(item.at)}</span>
                <span>{item.email}</span>
                <span>
                  {item.ok ? (
                    <Chip tone="success">成功</Chip>
                  ) : (
                    <Chip tone="danger" title={item.error || '失败'}>
                      {String(item.error || '失败').slice(0, 28)}
                    </Chip>
                  )}
                </span>
                <span className="mono muted">{item.token ? `${item.token}…` : '—'}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
