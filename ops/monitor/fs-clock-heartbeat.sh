#!/usr/bin/env bash
# 服务器 A 的时钟心跳（阶段 10 验收 8）：由 systemd timer 每 30 秒运行。
# 记录本机时间 sentAt 与上一轮的往返时间估计，POST 到 B 的 Worker /clock；
# Worker 用数据库时钟算两台机器的偏差并开/恢复 clock_skew、clock_skew_critical、fs_heartbeat 告警。
# 共享密钥与 Worker 地址只放在 /etc/fs-billing/heartbeat.env（0600 root:root）。
set -euo pipefail

heartbeat_env=${HEARTBEAT_ENV_FILE:-/etc/fs-billing/heartbeat.env}
rtt_file=${CLOCK_RTT_FILE:-/run/fs-billing-clock/rtt-ms}

usage() {
  cat <<'EOF'
用法：fs-clock-heartbeat.sh [--config <文件>]

  --config  环境文件，默认 /etc/fs-billing/heartbeat.env
            需要 CLOCK_WORKER_URL 与 WORKER_SHARED_KEY
EOF
}

fail() {
  printf '时钟心跳失败：%s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case $1 in
    --config)
      (($# >= 2)) || fail '--config 需要文件路径'
      heartbeat_env=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "未知参数：$1"
      ;;
  esac
done

[[ -r $heartbeat_env ]] || fail "读不到环境文件：$heartbeat_env"
# shellcheck source=/dev/null
. "$heartbeat_env"

[[ -n ${CLOCK_WORKER_URL:-} ]] || fail '缺少 CLOCK_WORKER_URL（例如 http://<B_WORKER_IP>:3001/clock）'
[[ -n ${WORKER_SHARED_KEY:-} ]] || fail '缺少 WORKER_SHARED_KEY'
command -v curl >/dev/null 2>&1 || fail '缺少命令 curl（Debian 包 curl）'
command -v jq >/dev/null 2>&1 || fail '缺少命令 jq（Debian 包 jq）'

# 用上一轮的往返时间做修正：本轮发出时还不知道本轮 RTT。第一次为 0。
previous_rtt=0
if [[ -r $rtt_file ]]; then
  saved=$(<"$rtt_file")
  if [[ $saved =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    previous_rtt=$saved
  fi
fi
install -d -m 0755 "$(dirname "$rtt_file")"

# chronyc 读不到时仍发心跳，把同步状态如实写成 false，Worker 会写进告警描述。
chrony_offset=0
chrony_synchronized=false
if tracking=$(chronyc -n tracking 2>/dev/null); then
  system_time=$(awk -F: '/^System time/ { sub(/^[ \t]+/, "", $2); print $2; exit }' <<<"$tracking")
  leap_status=$(awk -F: '/^Leap status/ { sub(/^[ \t]+/, "", $2); print $2; exit }' <<<"$tracking")
  if [[ -n $system_time && -n $leap_status ]]; then
    read -r offset _ direction <<<"$system_time"
    if [[ $offset =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
      if [[ ${direction:-} == slow ]]; then
        offset=$(awk -v v="$offset" 'BEGIN { printf "%.9f", -v }')
      fi
      chrony_offset=$offset
      [[ $leap_status == Normal ]] && chrony_synchronized=true
    fi
  fi
fi

payload=$(jq -cn \
  --arg sentAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  --argjson rttMs "$previous_rtt" \
  --argjson chronyOffsetSeconds "$chrony_offset" \
  --argjson chronySynchronized "$chrony_synchronized" \
  '{sentAt: $sentAt, rttMs: $rttMs, chronyOffsetSeconds: $chronyOffsetSeconds, chronySynchronized: $chronySynchronized}')

# sentAt 在 curl 之前取，和 RTT 的起点基本同一时刻。
started_at=$(date +%s%N)
if ! response=$(curl --noproxy '*' --silent --show-error --fail \
  --max-time 10 \
  --header "X-Billing-Key: $WORKER_SHARED_KEY" \
  --header 'Content-Type: application/json' \
  --data-binary "$payload" \
  "$CLOCK_WORKER_URL" 2>&1); then
  printf '时钟心跳 POST 失败：%s\n' "$response" >&2
  exit 1
fi
finished_at=$(date +%s%N)
round_trip_ms=$(((finished_at - started_at) / 1000000))
printf '%s\n' "$round_trip_ms" >"$rtt_file"

if [[ $response != '{"ok":true}' ]]; then
  printf '时钟心跳返回了非预期响应：%s\n' "$response" >&2
  exit 1
fi
printf '时钟心跳成功：skew 由 Worker 判断，本轮 RTT %s ms，chrony %s\n' \
  "$round_trip_ms" "$chrony_synchronized"
