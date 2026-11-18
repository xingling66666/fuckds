import { useCallback, useEffect, useMemo, useState } from 'react';

import { adminApi } from '../api.js';
import {
  Banner,
  Btn,
  Card,
  ErrorBanner,
  Select,
  TextField,
  Toggle,
  askConfirm,
  notify,
  toast,
} from '../ui.jsx';

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [values, setValues] = useState({});
  const [initial, setInitial] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminApi('/config');
      setConfig(data);
      setValues(data.values ?? {});
      setInitial(data.values ?? {});
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const changedKeys = useMemo(
    () => Object.keys(values).filter((key) => values[key] !== initial[key]),
    [values, initial],
  );

  const setValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!changedKeys.length) {
      toast('没有改动');
      return;
    }
    if (changedKeys.includes('API_KEY') && values.API_KEY === '') {
      const ok = await askConfirm('清空 API_KEY 后接口将不再鉴权（任何能访问端口的人都能调用），确定吗？', '清空 API Key', '清空');
      if (!ok) return;
    }
    setSaving(true);
    try {
      const payload = {};
      for (const key of changedKeys) payload[key] = values[key];
      const result = await adminApi('/config', { method: 'PUT', body: { values: payload } });
      toast(result.message ?? `已保存 ${result.saved.length} 项配置`);
      await load();
      if (result.restartRequired) {
        const ok = await askConfirm(
          `${result.message}\n\n现在重启服务吗？（会断开正在进行的对话）`,
          '部分配置需要重启',
          '立即重启',
        );
        if (ok) await restart();
      }
    } catch (err) {
      await notify(err.message, '保存失败');
    } finally {
      setSaving(false);
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
        toast('服务已恢复');
        await load();
      } else {
        await notify('重启后 45 秒内没有恢复，请到日志页查看原因。', '重启超时');
      }
    } catch (err) {
      await notify(err.message, '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <ErrorBanner message={error} onRetry={load} />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="page">
        <div className="loading-bar" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="muted">
            配置保存在 SQLite（data/config.db），保存后即时生效、无需重启；只有 HOST / PORT / CONCURRENCY / QUEUE_LIMIT / WARMUP
            这些启动时决定的项需要重启。
          </p>
        </div>
        <div className="page-actions">
          <Btn variant="tonal" icon="refresh" onClick={load}>
            重新读取
          </Btn>
          <Btn variant="filled" icon="save" loading={saving} disabled={!changedKeys.length} onClick={save}>
            保存{changedKeys.length ? `（${changedKeys.length} 项）` : ''}
          </Btn>
        </div>
      </div>

      {config.note ? (
        <Banner tone="info" icon="bolt">
          {config.note}
        </Banner>
      ) : null}

      {changedKeys.length ? (
        <Banner tone="warn" icon="edit_note">
          有 {changedKeys.length} 项改动还没保存：{changedKeys.join(' / ')}
        </Banner>
      ) : null}

      <Card title="配置项" subtitle={config.dbFile ?? config.envFile}>
        <div className="form-grid">
          {config.schema.map((item) => (
            <div className="field" key={item.key}>
              <span className="field-label">
                {item.label} <span className="mono muted">{item.key}</span>
              </span>
              <SettingControl item={item} value={values[item.key] ?? ''} onChange={(value) => setValue(item.key, value)} />
              {item.help ? <span className="field-help">{item.help}</span> : null}
            </div>
          ))}
        </div>
      </Card>

      <Card title="服务操作">
        <div className="row">
          <Btn variant="outlined" icon="restart_alt" loading={restarting} onClick={restart}>
            重启服务
          </Btn>
          <span className="field-note">
            日常改配置不需要重启（保存即生效）；只有 HOST / PORT / CONCURRENCY / QUEUE_LIMIT / WARMUP
            需要重启。重启会断开正在进行的对话；如果服务被 pm2 托管，请直接 pm2 restart。
          </span>
        </div>
      </Card>
    </div>
  );
}

function SettingControl({ item, value, onChange }) {
  if (item.type === 'select') {
    return (
      <Select
        value={value}
        onChange={onChange}
        options={item.options.map((option) => ({ value: option, label: option }))}
      />
    );
  }

  if (item.type === 'boolean') {
    return (
      <div className="field-row">
        <Toggle checked={value === 'true'} onChange={(checked) => onChange(checked ? 'true' : 'false')} />
        <span className="field-note">{value === 'true' ? '开启' : '关闭'}</span>
      </div>
    );
  }

  return (
    <TextField
      value={value}
      onChange={onChange}
      type={item.type === 'password' ? 'password' : item.type === 'number' ? 'number' : 'text'}
      togglePassword={item.type === 'password'}
      placeholder={item.type === 'password' && value ? '（已设置，留空表示清空）' : ''}
    />
  );
}
