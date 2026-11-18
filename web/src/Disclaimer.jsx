import { useEffect, useState } from 'react';

/**
 * 首次使用必须阅读的免责声明。
 *
 * 规则（写死，别改松）：
 *  - 用 localStorage 记住「已读」，key 带版本号，改条款就换版本号 → 所有人重看一次；
 *  - **没有读完 10 秒不允许关闭**（按钮置灰并显示倒计时）；
 *  - 不许点遮罩、不许按 ESC 关掉 —— 只能按底部按钮。
 */

const KEY = 'fuckds-disclaimer-ack-v1';
const HOLD_SECONDS = 10;

export function disclaimerAcknowledged() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export default function Disclaimer({ onAccept }) {
  const [left, setLeft] = useState(HOLD_SECONDS);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, []);

  const accept = () => {
    if (left > 0 || !checked) return;
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* 隐私模式：本次会话内记住即可 */
    }
    onAccept?.();
  };

  return (
    <div className="disclaimer-mask" role="dialog" aria-modal="true" aria-labelledby="disclaimer-title">
      <div className="disclaimer-card">
        <h2 id="disclaimer-title">免责声明</h2>
        <div className="disclaimer-body">
          <p>
            本程序仅用于<strong>个人学习与技术研究</strong>，用于把自己的账号接入自有客户端。请在使用前确认你的行为符合当地法律法规
            以及目标服务的使用条款。
          </p>
          <p>使用本程序即表示你理解并同意以下几点：</p>
          <ol>
            <li>
              使用非官方接口存在<strong>账号被限流、禁言或封禁</strong>的风险，风险与后果由使用者自行承担。
            </li>
            <li>
              作者<strong>不对任何直接或间接损失负责</strong>，包括但不限于账号损失、数据丢失、服务中断、法律责任。
            </li>
            <li>
              请勿将本程序用于<strong>绕过付费、攻击服务、侵犯他人隐私</strong>等用途；由此产生的一切后果由使用者自负。
            </li>
            <li>
              本项目<strong>不提供任何担保</strong>，也不承诺持续可用；接口随时可能失效。
            </li>
            <li>如你不同意以上任何一条，请立即停止使用并删除本程序。</li>
          </ol>
          <p className="muted">
            继续使用前，请阅读同意以上条款
          </p>
        </div>

        <label className="disclaimer-check">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          <span>我已阅读并同意上述全部条款</span>
        </label>

        <div className="disclaimer-actions">
          <span className="muted">
            {left > 0 ? `请阅读 ${left} 秒后可继续` : '可以继续了'}
          </span>
          <button
            type="button"
            className="disclaimer-btn"
            disabled={left > 0 || !checked}
            onClick={accept}
          >
            {left > 0 ? `同意并继续（${left}s）` : '同意并继续'}
          </button>
        </div>
      </div>
    </div>
  );
}
