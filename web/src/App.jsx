import { useEffect, useState } from 'react';
import { setTheme } from 'mdui';

import { getApiKey, setApiKey, setUnauthorizedHandler } from './api.js';
import { Btn, IconBtn, ListItem, TextField, toast } from './ui.jsx';
import Overview from './pages/Overview.jsx';
import Accounts from './pages/Accounts.jsx';
import Playground from './pages/Playground.jsx';
import Logs from './pages/Logs.jsx';
import Settings from './pages/Settings.jsx';
import Register from './pages/Register.jsx';
import Docs from './pages/Docs.jsx';
import Disclaimer, { disclaimerAcknowledged } from './Disclaimer.jsx';

const PAGES = [
  { id: 'overview', label: '概览', icon: 'dashboard', hint: '服务状态、账号池、最近日志' },
  { id: 'accounts', label: '账号', icon: 'key', hint: '管理 DeepSeek 登录态（号池）' },
  { id: 'register', label: '注册', icon: 'person_add', hint: '一键自动注册新号，支持定时' },
  { id: 'playground', label: '测试', icon: 'chat', hint: '直接发请求，逐字看输出' },
  { id: 'logs', label: '日志', icon: 'receipt_long', hint: '实时查看服务日志' },
  { id: 'settings', label: '设置', icon: 'tune', hint: '运行时配置与重启' },
  { id: 'docs', label: '文档', icon: 'menu_book', hint: '接口速查与调用示例' },
];

const COMPONENTS = {
  overview: Overview,
  accounts: Accounts,
  register: Register,
  playground: Playground,
  logs: Logs,
  settings: Settings,
  docs: Docs,
};

const THEME_KEY = 'fuckds-admin-theme';
const THEME_ORDER = ['auto', 'light', 'dark'];
const THEME_ICON = { auto: 'brightness_auto', light: 'light_mode', dark: 'dark_mode' };
const THEME_LABEL = { auto: '主题：跟随系统', light: '主题：浅色', dark: '主题：深色' };

export default function App({ initialTheme = 'auto' }) {
  const [acknowledged, setAcknowledged] = useState(() => disclaimerAcknowledged());
  const [page, setPage] = useState('overview');
  const [refreshKey, setRefreshKey] = useState(0);
  const [theme, setThemeState] = useState(initialTheme);
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setKeyDraft(getApiKey());
      setKeyDialogOpen(true);
    });
  }, []);

  useEffect(() => {
    setTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 隐私模式忽略 */
    }
  }, [theme]);

  const current = PAGES.find((item) => item.id === page) ?? PAGES[0];
  const Page = COMPONENTS[current.id];

  const cycleTheme = () => {
    setThemeState((prev) => THEME_ORDER[(THEME_ORDER.indexOf(prev) + 1) % THEME_ORDER.length]);
  };

  const saveKey = () => {
    setApiKey(keyDraft.trim());
    setKeyDialogOpen(false);
    setRefreshKey((value) => value + 1);
    toast('API Key 已保存');
  };

  const clearKey = () => {
    setApiKey('');
    setKeyDraft('');
    setKeyDialogOpen(false);
    setRefreshKey((value) => value + 1);
    toast('已清除本机保存的 API Key');
  };

  if (!acknowledged) {
    return <Disclaimer onAccept={() => setAcknowledged(true)} />;
  }

  return (
    <div className="layout">
      <mdui-top-app-bar>
        <mdui-top-app-bar-title>fuckds 控制台</mdui-top-app-bar-title>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <Btn variant="text" icon="open_in_new" href="/" target="_blank">
            接口首页
          </Btn>
          <IconBtn icon="refresh" title="刷新当前页" onClick={() => setRefreshKey((value) => value + 1)} />
          <IconBtn icon={THEME_ICON[theme]} title={THEME_LABEL[theme]} onClick={cycleTheme} />
          {getApiKey() ? (
            <IconBtn
              icon="key"
              title="修改 API Key"
              onClick={() => {
                setKeyDraft(getApiKey());
                setKeyDialogOpen(true);
              }}
            />
          ) : null}
        </div>
      </mdui-top-app-bar>

      <div className="shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <strong>DeepSeek 网页版</strong>
            <span>→ OpenAI / Anthropic API</span>
          </div>
          <mdui-list>
            {PAGES.map((item) => (
              <ListItem
                key={item.id}
                icon={item.icon}
                active={item.id === page}
                onClick={() => setPage(item.id)}
              >
                {item.label}
              </ListItem>
            ))}
          </mdui-list>
          <div className="sidebar-hint">
            <strong>{current.label}</strong>
            <br />
            {current.hint}
          </div>
        </aside>

        <main className="main">
          <Page key={`${page}-${refreshKey}`} navigate={setPage} />
          <div className="footer-note">
            fuckds · 控制台跑在同一个 Node 进程里 · 接口文档见「文档」页
          </div>
        </main>
      </div>

      {keyDialogOpen ? (
        <div className="dialog-backdrop" onClick={() => setKeyDialogOpen(false)}>
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <h2>需要 API Key</h2>
            <p className="muted">
              服务端配置了 <code>API_KEY</code>，后台接口需要带上同一个 key 才能访问。
              输入一次后会保存在本机浏览器的 localStorage 里（key 在项目根目录的 .env，或控制台「设置」页里改）。
            </p>
            <TextField
              label="API Key"
              type="password"
              togglePassword
              value={keyDraft}
              onChange={setKeyDraft}
              autosize
            />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              {getApiKey() ? (
                <Btn variant="text" onClick={clearKey}>
                  清除已保存的 Key
                </Btn>
              ) : null}
              <Btn variant="text" onClick={() => setKeyDialogOpen(false)}>
                取消
              </Btn>
              <Btn variant="filled" onClick={saveKey}>
                保存并重试
              </Btn>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
