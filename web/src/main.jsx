import React from 'react';
import { createRoot } from 'react-dom/client';
import 'mdui/mdui.css';
import 'mdui';
import * as zhCnLocale from 'mdui/locales/zh-cn.js';
import { loadLocale, setColorScheme, setLocale, setTheme } from 'mdui';

import './styles.css';
import App from './App.jsx';

// 组件内置文案（文本框校验、对话框按钮等）走 mdui 的本地化
loadLocale(async () => zhCnLocale);
setLocale('zh-cn').catch(() => {});

const THEME_KEY = 'fuckds-admin-theme';
const savedTheme = localStorage.getItem(THEME_KEY) || 'auto';
setTheme(savedTheme);
// 后台配色统一成蓝色（mdui 会据此生成浅色/深色两套调色板）
setColorScheme('#1f6ff2');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App initialTheme={savedTheme} />
  </React.StrictMode>,
);
