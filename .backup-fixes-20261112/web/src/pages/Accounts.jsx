import { useCallback, useEffect, useState } from 'react';

import { adminApi } from '../api.js';
import {
  Banner,
  Btn,
  Card,
  Chip,
  Empty,
  ErrorBanner,
  IconBtn,
  Select,
  TextField,
  askConfirm,
  formatMs,
  notify,
  toast,
} from '../ui.jsx';

const MODE_OPTIONS = [
  { value: 'append', label: '追加到现有号池' },
  { value: 'replace', label: '替换全部（覆盖号池）' },
];

export default function Accounts() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('append');
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifyResults, setVerifyResults] = useState(null);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await adminApi('/accounts'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const verify = async () => {
    if (!input.trim()) {
      toast('先粘贴要校验的 token');
      return;
    }
    setVerifying(true);
    setVerifyResults(null);
    try {
      const result = await adminApi('/accounts/verify', { method: 'POST', body: { tokens: input } });
      setVerifyResults(result.results ?? []);
      if (result.ok) toast('全部校验通过');
    } catch (err) {
      await notify(err.message, '校验失败');
    } finally {
      setVerifying(false);
    }
  };

  const save = async () => {
    if (!input.trim()) {
      toast('先粘贴要保存的 token');
      return;
    }
    setSaving(true);
    try {
      const result = await adminApi('/accounts', { method: 'POST', body: { tokens: input, mode } });
      setPendingRestart(Boolean(result.restartRequired));
      setInput('');
      setVerifyResults(null);
      await load();
      toast(`已保存 ${result.savedCount} 个 token`);
      if (result.restartRequired) {
        await notify(result.message, '需要重启生效');
      }
    } catch (err) {
      await notify(err.message, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (index) => {
    const ok = await askConfirm(`确定从号池里删除第 ${index} 个 token 吗？`, '删除 token', '删除');
    if (!ok) return;
    try {
      await adminApi('/accounts/remove', { method: 'POST', body: { index } });
      await load();
      setPendingRestart(true);
      toast('已删除，重启后生效');
    } catch (err) {
      await notify(err.message, '删除失败');
    }
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await adminApi('/restart', { method: 'POST' });
      toast('正在重启，等待服务恢复…');
      let recovered = false;
      for (let i = 0; i < 45; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            recovered = true;
            break;
          }
        } catch {
          /* 继续等 */
        }
      }
      if (recovered) {
        setPendingRestart(false);
        await load();
        toast('服务已恢复，号池已加载');
      } else {
        await notify('重启后 45 秒内没有恢复，请到日志页查看原因。', '重启超时');
      }
    } catch (err) {
      await notify(err.message, '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  const runtime = data?.runtime ?? [];
  const saved = data?.saved ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>账号</h1>
          <p className="muted">
            userToken 从浏览器 F12 → Application → Local Storage → chat.deepseek.com → userToken → value 复制。
            一行一个，支持多个（号池会轮询换号绕限流）。
          </p>
        </div>
        <div className="page-actions">
          <Btn variant="tonal" icon="refresh" onClick={load}>
            刷新
          </Btn>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      {pendingRestart ? (
        <Banner
          tone="warn"
          icon="restart_alt"
          actions={
            <Btn variant="filled" size="small" loading={restarting} onClick={restart}>
              立即重启
            </Btn>
          }
        >
          token 已写入 data/auth.json，但运行中的进程还在用旧号池。重启服务后生效。
        </Banner>
      ) : null}

      <Card title="添加 / 更新 token" subtitle="粘贴后可以先校验登录态，再保存">
        <div className="stack">
          <TextField
            label="userToken（可多行）"
            placeholder={'粘贴 userToken，一行一个\n也支持 localStorage 里的原始值 {"value":"...","__version":"0"}'}
            rows={4}
            value={input}
            onChange={setInput}
            helper="多个 token 用换行、空格或逗号分隔都可以"
          />
          <div className="row">
            <Select value={mode} onChange={setMode} options={MODE_OPTIONS} style={{ width: 220 }} />
            <div className="grow" />
            <Btn variant="outlined" icon="verified_user" loading={verifying} onClick={verify}>
              校验登录态
            </Btn>
            <Btn variant="filled" icon="save" loading={saving} onClick={save}>
              保存
            </Btn>
          </div>

          {verifyResults ? (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>结果</th>
                    <th>说明</th>
                    <th>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {verifyResults.map((item, index) => (
                    <tr key={`${item.token}-${index}`}>
                      <td className="mono">{item.token}</td>
                      <td>{item.ok ? <Chip tone="ok">有效</Chip> : <Chip tone="error">失败</Chip>}</td>
                      <td className="muted">{item.detail}</td>
                      <td className="numeric">{item.ms != null ? formatMs(item.ms) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Card>

      <Card
        title={`已保存的 token（${data?.savedCount ?? saved.length} 个）`}
        subtitle="data/auth.json · 重启服务后加载进号池"
      >
        {saved.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Token</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {saved.map((item) => (
                  <tr key={item.index}>
                    <td className="numeric">{item.index}</td>
                    <td className="mono">{item.token}</td>
                    <td>
                      <IconBtn
                        icon="delete_outline"
                        title="从号池删除"
                        onClick={() => remove(item.index)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>号池是空的，先在上面粘贴 userToken 保存</Empty>
        )}
      </Card>

      <Card
        title={`运行中的号池（${runtime.length} 个）`}
        subtitle={data?.savedAt ? `上次保存：${new Date(data.savedAt).toLocaleString('zh-CN', { hour12: false })}` : null}
      >
        {runtime.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Token</th>
                  <th>状态</th>
                  <th>请求数</th>
                  <th>限流次数</th>
                  <th>错误数</th>
                  <th>冷却</th>
                  <th>最近错误</th>
                </tr>
              </thead>
              <tbody>
                {runtime.map((account) => (
                  <tr key={account.index}>
                    <td className="numeric">{account.index}</td>
                    <td className="mono">{account.token}</td>
                    <td>
                      {account.authFailed ? (
                        <Chip tone="error">登录态失效</Chip>
                      ) : account.available ? (
                        <Chip tone="ok">可用</Chip>
                      ) : (
                        <Chip tone="warn">冷却 {formatMs(account.cooldownMs)}</Chip>
                      )}
                    </td>
                    <td className="numeric">{account.requests}</td>
                    <td className="numeric">{account.limited}</td>
                    <td className="numeric">{account.errors}</td>
                    <td className="numeric">{account.cooldownMs ? formatMs(account.cooldownMs) : '—'}</td>
                    <td className="muted">{account.lastError || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>运行中的进程没有账号：先在「已保存的 token」里添加并重启服务</Empty>
        )}
      </Card>
    </div>
  );
}
