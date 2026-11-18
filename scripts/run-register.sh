#!/usr/bin/env bash
# 一条命令跑完一次注册（换 IP 后直接用）
#
#   ./run-register.sh 邮箱 [验证码文件]
#
# 流程：出口 IP 自检 → 过 WAF → 填表 → 自动过 hCaptcha(无障碍题) → 发码
#       → 轮询验证码文件 → 填码 → 注册 → userToken 入号池
set -euo pipefail
cd "$(dirname "$0")/.."

# 不传邮箱就按时间戳自动生成一个新别名（避免撞已注册的地址）
MAIL="${1:-xingling9464+ds$(date +%Y%m%d%H%M%S)@outlook.com}"
CODE_FILE="${2:-/root/dsh/code.txt}"
PROXY="${CLASH:-http://127.0.0.1:7890}"

echo "=== 出口 IP ==="
curl -sS -x "$PROXY" https://ipinfo.io/json | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("ip"),d.get("country"),d.get("org"))'
echo "=== 开始注册：$MAIL ==="
echo "$MAIL" > /root/dsh/last_alias.txt
: > "$CODE_FILE" 2>/dev/null || true

DS_CHROME="${DS_CHROME:-/usr/bin/chromium}" \
DS_CODE_FILE="$CODE_FILE" \
exec node scripts/vnc-auto-try.mjs "$PROXY" "$MAIL"
