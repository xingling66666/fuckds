#!/usr/bin/env bash
#
# fuckds 一键安装
#
#   sudo ./scripts/install.sh                       # 默认 127.0.0.1:8787
#   sudo ./scripts/install.sh --host 0.0.0.0 --api-key sk-xxx
#   sudo ./scripts/install.sh --no-browser          # 跳过 Chromium 下载（只做 API 转发）
#   sudo ./scripts/install.sh --uninstall
#
# 装什么：
#   1. 二进制            → /opt/fuckds/fuckds（软链 /usr/local/bin/fuckds）
#   2. playwright 依赖    → /opt/fuckds/node_modules（离线优先从源码树拷贝，缺失才 npm 装）
#   3. Chromium 浏览器    → /opt/fuckds/browsers（npx playwright install --with-deps chromium）
#   4. 系统用户 + 数据目录 → fuckds / /var/lib/fuckds
#   5. systemd 服务       → /etc/systemd/system/fuckds.service（开机自启）
#
set -euo pipefail

APP=fuckds
SERVICE="${APP}.service"
INSTALL_DIR="/opt/${APP}"
BIN_LINK="/usr/local/bin/${APP}"
UNIT_DIR="/etc/systemd/system"
DEFAULT_DATA="/var/lib/${APP}"
DEFAULT_PORT=8787
DEFAULT_HOST=127.0.0.1
DEFAULT_USER="${APP}"

PORT="$DEFAULT_PORT"
HOST="$DEFAULT_HOST"
DATA_DIR="$DEFAULT_DATA"
RUN_USER="$DEFAULT_USER"
API_KEY=""
ENGINE="hybrid"
DO_START=1
DO_BROWSER=1
DO_UNINSTALL=0
PRINT_UNIT=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

参数：
  --port <端口>      监听端口（默认 8787）
  --host <地址>      监听地址（默认 127.0.0.1；公网用 0.0.0.0）
  --data <目录>      数据目录（默认 /var/lib/fuckds）
  --user <用户名>    运行用户（默认 fuckds，自动创建系统用户）
  --api-key <key>    接口鉴权 key（默认不鉴权）
  --engine <模式>    hybrid（默认）/ direct
  --install-dir <目录>  程序目录（默认 /opt/fuckds）
  --no-browser       不安装 Chromium（只做 API 转发；登录/注册/代理测试不可用）
  --no-start         装完不启动
  --print-unit       只打印 systemd 单元
  --uninstall        卸载（保留数据目录）
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="${2:?}"; shift 2 ;;
    --host) HOST="${2:?}"; shift 2 ;;
    --data) DATA_DIR="${2:?}"; shift 2 ;;
    --user) RUN_USER="${2:?}"; shift 2 ;;
    --api-key) API_KEY="${2:?}"; shift 2 ;;
    --engine) ENGINE="${2:?}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:?}"; shift 2 ;;
    --no-browser) DO_BROWSER=0; shift ;;
    --no-start) DO_START=0; shift ;;
    --print-unit) PRINT_UNIT=1; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

unit_content() {
  local envs=(
    "Environment=DS_ENGINE=${ENGINE}"
    "Environment=HOME=${INSTALL_DIR}"
    "Environment=NODE_PATH=${INSTALL_DIR}/node_modules"
    "Environment=PLAYWRIGHT_BROWSERS_PATH=${INSTALL_DIR}/browsers"
  )
  [[ -n "$API_KEY" ]] && envs+=("Environment=API_KEY=${API_KEY}")
  cat <<EOF
[Unit]
Description=${APP} —— DeepSeek 网页版 → OpenAI / Anthropic 兼容 API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/${APP} --port ${PORT} --host ${HOST} --data ${DATA_DIR}
$(printf '%s\n' "${envs[@]}")
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
LimitNOFILE=65535

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
}

if [[ $PRINT_UNIT -eq 1 ]]; then
  unit_content
  exit 0
fi

# ---------------------------------------------------------------- 卸载
if [[ $DO_UNINSTALL -eq 1 ]]; then
  [[ $EUID -eq 0 ]] || die "卸载需要 root"
  log "卸载 ${APP}"
  systemctl stop "$SERVICE" 2>/dev/null || true
  systemctl disable "$SERVICE" 2>/dev/null || true
  rm -f "${UNIT_DIR}/${SERVICE}" "$BIN_LINK"
  rm -rf "$INSTALL_DIR"
  systemctl daemon-reload || true
  ok "服务、程序目录已移除；只有数据留在 ${DATA_DIR}"
  warn "彻底清理：rm -rf ${DATA_DIR} /tmp/${APP}-pow"
  exit 0
fi

# ---------------------------------------------------------------- 前置
[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo $0 ...）"
command -v systemctl >/dev/null || die "没有 systemd，装不了服务"

find_binary() {
  for c in "${ROOT_DIR}/bin/${APP}" "${ROOT_DIR}/bin/freetoken" "${ROOT_DIR}/${APP}"; do
    [[ -x "$c" ]] && { echo "$c"; return 0; }
  done
  return 1
}

BIN_SRC="$(find_binary || true)"
if [[ -z "$BIN_SRC" ]]; then
  warn "没找到编译好的二进制，现场构建"
  command -v bun >/dev/null || die "构建需要 bun：curl -fsSL https://bun.sh/install | bash"
  ( cd "$ROOT_DIR" && { [[ -d web/dist ]] || npm --prefix web run build; } )
  ( cd "$ROOT_DIR" && npm run build:binary )
  BIN_SRC="${ROOT_DIR}/bin/${APP}"
fi
ok "二进制：${BIN_SRC}（$(du -h "$BIN_SRC" | cut -f1)）"

# ---------------------------------------------------------------- 用户 / 目录
if ! id -u "$RUN_USER" >/dev/null 2>&1; then
  log "创建系统用户 ${RUN_USER}"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER" 2>/dev/null \
    || useradd --system --no-create-home --shell /sbin/nologin "$RUN_USER"
fi
ok "运行用户：${RUN_USER}"

log "准备目录 ${INSTALL_DIR} / ${DATA_DIR}"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
chown -R "${RUN_USER}:${RUN_USER}" "$INSTALL_DIR" "$DATA_DIR"
chmod 755 "$INSTALL_DIR"
chmod 750 "$DATA_DIR"

log "安装二进制 → ${INSTALL_DIR}/${APP}"
install -m 0755 "$BIN_SRC" "${INSTALL_DIR}/${APP}"
ln -sf "${INSTALL_DIR}/${APP}" "$BIN_LINK"
chown -h "${RUN_USER}:${RUN_USER}" "$BIN_LINK" 2>/dev/null || true
ok "$("${INSTALL_DIR}/${APP}" --version 2>/dev/null || echo 可执行)"

# ---------------------------------------------------------------- 依赖：playwright
log "安装 playwright 运行时依赖 → ${INSTALL_DIR}/node_modules"
mkdir -p "${INSTALL_DIR}/node_modules"

copied=0
if [[ -d "${ROOT_DIR}/node_modules/playwright" ]]; then
  for pkg in playwright playwright-core; do
    if [[ -d "${ROOT_DIR}/node_modules/${pkg}" ]]; then
      rm -rf "${INSTALL_DIR}/node_modules/${pkg}"
      cp -a "${ROOT_DIR}/node_modules/${pkg}" "${INSTALL_DIR}/node_modules/"
      copied=1
    fi
  done
fi

if [[ $copied -eq 1 ]]; then
  ok "已从源码树拷贝 playwright（离线，$(du -sh "${INSTALL_DIR}/node_modules" | cut -f1)）"
else
  if command -v npm >/dev/null; then
    ( cd "$INSTALL_DIR" && [[ -f package.json ]] || npm init -y >/dev/null 2>&1
      npm install --omit=dev playwright >/dev/null 2>&1 ) \
      && ok "已用 npm 安装 playwright" \
      || warn "npm 安装 playwright 失败；登录/注册/代理测试将不可用（核心转发不受影响）"
  else
    warn "目标机没有 npm/bun，跳过 playwright；核心转发不受影响"
  fi
fi
chown -R "${RUN_USER}:${RUN_USER}" "${INSTALL_DIR}/node_modules"

# ---------------------------------------------------------------- 浏览器
if [[ $DO_BROWSER -eq 1 ]]; then
  log "准备 Chromium（登录 / 注册 / 代理测试需要）"
  BROWSERS_DIR="${INSTALL_DIR}/browsers"
  mkdir -p "$BROWSERS_DIR"

  # 离线优先：从源码树的 ms-playwright 缓存拷（快且不依赖网络）
  src_cache="${PLAYWRIGHT_BROWSERS_PATH:-${HOME:-/root}/.cache/ms-playwright}"
  if [[ -d "$src_cache" ]] && compgen -G "${src_cache}/chromium-*" >/dev/null; then
    cp -a "${src_cache}"/chromium-* "$BROWSERS_DIR"/ 2>/dev/null || true
    [[ -d "${src_cache}/chromium_headless_shell-1254" ]] && cp -a "${src_cache}"/chromium_headless_shell-* "$BROWSERS_DIR"/ 2>/dev/null || true
    ok "已从本地缓存拷贝 Chromium"
  fi

  if ! compgen -G "${BROWSERS_DIR}/chromium-*" >/dev/null; then
    if command -v npx >/dev/null; then
      export PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR"
      log "下载 Chromium（约 150MB，可能需要几分钟）"
      ( cd "$INSTALL_DIR" && npx --yes playwright install --with-deps chromium >/tmp/${APP}-browser.log 2>&1 ) \
        && ok "Chromium 已安装" \
        || warn "Chromium 安装失败，详见 /tmp/${APP}-browser.log；核心转发不受影响"
    else
      warn "没有 npx，跳过浏览器安装"
    fi
  fi

  # 系统里已有 chromium 时也给个兜底路径
  if [[ -x /usr/bin/chromium ]]; then
    ok "检测到系统 Chromium：/usr/bin/chromium"
  fi
  chown -R "${RUN_USER}:${RUN_USER}" "$BROWSERS_DIR" 2>/dev/null || true
else
  warn "跳过浏览器安装（--no-browser）"
fi

# ---------------------------------------------------------------- systemd
log "写入 ${UNIT_DIR}/${SERVICE}"
unit_content > "${UNIT_DIR}/${SERVICE}"
chmod 644 "${UNIT_DIR}/${SERVICE}"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
ok "服务已注册（开机自启）"

if [[ $DO_START -eq 1 ]]; then
  log "启动服务"
  systemctl restart "$SERVICE"
  printf '  健康检查'
  healthy=0
  for _ in $(seq 1 40); do
    sleep 1; printf '.'
    if curl -fsS --max-time 2 "http://${HOST/0.0.0.0/127.0.0.1}:${PORT}/healthz" >/dev/null 2>&1; then
      healthy=1; break
    fi
  done
  echo
  if [[ $healthy -eq 1 ]]; then
    ok "服务已启动"
  else
    warn "健康检查未通过，看日志：journalctl -u ${SERVICE} -n 80 --no-pager"
    systemctl status "$SERVICE" --no-pager -l | sed -n '1,18p' || true
    exit 2
  fi
else
  warn "已跳过启动（--no-start）"
fi

BASE_HOST="${HOST/0.0.0.0/127.0.0.1}"
cat <<EOF

  安装完成

  接口      http://${BASE_HOST}:${PORT}/v1/chat/completions
  后台      http://${BASE_HOST}:${PORT}/admin/
  健康检查  http://${BASE_HOST}:${PORT}/healthz

  程序目录  ${INSTALL_DIR}（node_modules / browsers 都在这）
  数据目录  ${DATA_DIR}
  服务管理  systemctl {status|restart|stop} ${SERVICE}
  实时日志  journalctl -u ${SERVICE} -f

下一步：打开后台 → 同意免责声明 → 「账号」页贴 userToken
EOF
