const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  trace: '\u001b[90m',
};
const RESET = '\u001b[0m';

export const LOG_LEVELS = Object.keys(LEVELS);

function makeLogger(state, scope) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;

  const emit = (lvl, args) => {
    if ((LEVELS[lvl] ?? 99) > state.threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const tag = color ? `${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}` : lvl.toUpperCase().padEnd(5);
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${time} ${tag} ${prefix}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    out(line, ...args);
  };

  return {
    /** 当前级别名（动态取，root 和 child 共享同一个阈值） */
    get level() {
      const found = Object.entries(LEVELS).find(([, value]) => value === state.threshold);
      return found ? found[0] : 'info';
    },
    /** 热更日志级别：所有由同一个 root 派生的 child 一起生效 */
    setLevel(next) {
      state.threshold = LEVELS[String(next).toLowerCase()] ?? LEVELS.info;
      return this.level;
    },
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
    trace: (...a) => emit('trace', a),
    child: (childScope) => makeLogger(state, scope ? `${scope}:${childScope}` : childScope),
  };
}

/**
 * 极简 logger。
 *
 * 阈值放在 root 与所有 child 共享的 state 里：后台保存 LOG_LEVEL 后调用
 * `logger.setLevel(...)`，已经在用的 child（admin/web/login…）会一起生效，
 * 不需要重建 logger。
 */
export function createLogger(level = 'info', scope = '') {
  return makeLogger({ threshold: LEVELS[level] ?? LEVELS.info }, scope);
}
