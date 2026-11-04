#!/usr/bin/env bash
# 服务器 B 自身相对 NTP 的偏差（阶段 10 验收 8）：由 systemd timer 每分钟运行。
# 只读 chronyc tracking，不依赖 Worker、API 或数据库；异常经 notify.sh 发邮件，所以
# 应用或数据库整体宕机时这条监测仍然工作。
#
#   ops/monitor/check-clock.sh [--config /etc/fs-billing/monitor.env]
#
# 阈值（用户决定 3）：警告 1 秒、严重 5 秒。Leap status 不是 Normal 或读不到 chronyc
# 视为监测失效，按同一通道告警。同一问题 30 分钟内不重复发信。
set -euo pipefail

monitor_env=${MONITOR_ENV_FILE:-/etc/fs-billing/monitor.env}
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() {
  cat <<'EOF'
用法：check-clock.sh [--config <文件>]

  --config  环境文件，默认 /etc/fs-billing/monitor.env
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case $1 in
    --config)
      (($# >= 2)) || fail '--config 需要文件路径'
      monitor_env=$2
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

if [[ -r $monitor_env ]]; then
  # shellcheck source=/dev/null
  . "$monitor_env"
fi
# 让 notify.sh 读同一个配置文件（--config 与默认路径都适用）。
export MONITOR_ENV_FILE=$monitor_env

warn_seconds=${CLOCK_WARN_SECONDS:-1}
crit_seconds=${CLOCK_CRIT_SECONDS:-5}
state_dir=${MONITOR_STATE_DIR:-/var/lib/fs-billing/monitor}
dedupe_seconds=${MONITOR_DEDUPE_SECONDS:-1800}
notify=$repo_dir/notify.sh

install -d -m 0700 "$state_dir"

log() {
  logger -t fs-billing-check-clock -- "$*"
}

at_least() {
  awk -v value="$1" -v limit="$2" 'BEGIN { exit !(value + 0 >= limit + 0) }'
}

send_once() {
  local key=$1 subject=$2 body=$3 marker now last
  marker=$state_dir/$key
  now=$(date -u +%s)
  last=0
  if [[ -r $marker ]]; then
    last=$(<"$marker")
    [[ $last =~ ^[0-9]+$ ]] || last=0
  fi
  if ((now - last < dedupe_seconds)); then
    log "同一问题在 ${dedupe_seconds} 秒内已通知，跳过邮件：$subject"
    return 0
  fi
  "$notify" --subject "$subject" --body "$body"
  printf '%s\n' "$now" >"$marker"
}

clear_state() {
  rm -f -- "$state_dir/clock-skew" "$state_dir/clock-unavailable"
}

tracking=$(chronyc -n tracking 2>&1) || {
  message="无法读取 chronyc tracking，服务器 B 的时钟监测失效：
$tracking"
  log "$message"
  send_once clock-unavailable '【FS-Billing】服务器 B 时钟监测失效' "$message"
  exit 1
}

system_time=$(awk -F: '/^System time/ { sub(/^[ \t]+/, "", $2); print $2; exit }' <<<"$tracking")
leap_status=$(awk -F: '/^Leap status/ { sub(/^[ \t]+/, "", $2); print $2; exit }' <<<"$tracking")

if [[ -z $system_time || -z $leap_status ]]; then
  message="chronyc tracking 缺少 System time 或 Leap status，无法判断时钟偏差：
$tracking"
  log "$message"
  send_once clock-unavailable '【FS-Billing】服务器 B 时钟监测失效' "$message"
  exit 1
fi

read -r offset _ direction <<<"$system_time"
if [[ ! $offset =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
  message="无法解析 chronyc tracking 的 System time：$system_time"
  log "$message"
  send_once clock-unavailable '【FS-Billing】服务器 B 时钟监测失效' "$message"
  exit 1
fi
if [[ ${direction:-} == slow ]]; then
  offset=$(awk -v v="$offset" 'BEGIN { printf "%.9f", -v }')
fi
absolute=$(awk -v v="$offset" 'BEGIN { if (v < 0) v = -v; printf "%.6f", v }')

if [[ $leap_status != Normal ]]; then
  message="服务器 B 的 chrony 未同步（Leap status: $leap_status），当前偏差读数不可信。"
  log "$message"
  send_once clock-unavailable '【FS-Billing】服务器 B 时钟未同步' "$message"
  exit 1
fi

if at_least "$absolute" "$crit_seconds"; then
  level='严重'
elif at_least "$absolute" "$warn_seconds"; then
  level='警告'
else
  if [[ -e $state_dir/clock-skew || -e $state_dir/clock-unavailable ]]; then
    log "服务器 B 时钟恢复正常：偏差 ${absolute} 秒，chrony 已同步"
  fi
  clear_state
  exit 0
fi

message="服务器 B 相对 NTP 的偏差为 ${absolute} 秒（${level}；阈值 警告 ${warn_seconds} 秒、严重 ${crit_seconds} 秒）。
偏移方向：$direction
Leap status：$leap_status
完整 chronyc tracking：
$tracking"
log "$message"
send_once clock-skew "【FS-Billing】服务器 B 时钟偏差：${level}（${absolute} 秒）" "$message"
exit 1
