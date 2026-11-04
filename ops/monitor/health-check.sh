#!/usr/bin/env bash
# 服务器 B 的本机体检（阶段 10「存活监测」）：由 systemd timer 每分钟运行。
# 检查 Worker /health、API /api/health、PostgreSQL、LATEST.json 新鲜度、
# 磁盘、证书剩余天数和 journal 用量。失败经 notify.sh 发邮件；同一问题 30 分钟内
# 不重复。只依赖本机命令与两个 env 文件，Worker、API 或数据库宕机时仍能执行。
set -euo pipefail

monitor_env=${MONITOR_ENV_FILE:-/etc/fs-billing/monitor.env}
app_env=${APP_ENV_FILE:-/etc/fs-billing/app.env}
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() {
  cat <<'EOF'
用法：health-check.sh [--config <文件>]

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
if [[ -r $app_env ]]; then
  # shellcheck source=/dev/null
  . "$app_env"
fi

state_dir=${MONITOR_STATE_DIR:-/var/lib/fs-billing/monitor}
dedupe_seconds=${MONITOR_DEDUPE_SECONDS:-1800}
latest_json=${BACKUP_LATEST_JSON:-/root/backups/LATEST.json}
latest_max_age=${BACKUP_MAX_AGE_SECONDS:-93600} # 26 小时
disk_warn_percent=${DISK_WARN_PERCENT:-90}
cert_file=${TLS_CERT_FILE:-/etc/ssl/fs-billing/fullchain.pem}
cert_warn_days=${CERT_WARN_DAYS:-30}
journal_warn_bytes=${JOURNAL_WARN_BYTES:-1932735283} # 2G 的 90%
api_url=${HEALTH_API_URL:-http://${API_HOST:-127.0.0.1}:${API_PORT:-3000}/api/health}
worker_url=${HEALTH_WORKER_URL:-http://${WORKER_HOST:-127.0.0.1}:${WORKER_PORT:-3001}/health}
notify=$repo_dir/notify.sh

install -d -m 0700 "$state_dir"

failures=0
due_keys=()
due_messages=()

log() {
  logger -t fs-billing-health-check -- "$*"
}

notify_due() {
  local key=$1 message=$2 marker now last
  marker=$state_dir/$key
  now=$(date -u +%s)
  last=0
  if [[ -r $marker ]]; then
    last=$(<"$marker")
    [[ $last =~ ^[0-9]+$ ]] || last=0
  fi
  if ((now - last < dedupe_seconds)); then
    log "失败（${dedupe_seconds} 秒内已通知）：$message"
    return 0
  fi
  due_keys+=("$key")
  due_messages+=("$message")
}

ok_check() {
  local key=$1
  if [[ -e $state_dir/$key ]]; then
    log "恢复：$key"
    rm -f -- "$state_dir/$key"
  fi
}

bad_check() {
  failures=$((failures + 1))
  log "失败：$2"
  notify_due "$1" "$2"
}

check_http() {
  local key=$1 label=$2 url=$3 body
  if ! body=$(curl --noproxy '*' --silent --show-error --fail --max-time 5 "$url" 2>&1); then
    bad_check "$key" "$label 不可用：$url（$body）"
    return
  fi
  if ! jq -e '.status == "ok"' <<<"$body" >/dev/null 2>&1; then
    bad_check "$key" "$label 返回了非预期响应：$url（$body）"
    return
  fi
  ok_check "$key"
}

check_backup_freshness() {
  local mtime now age
  if [[ ! -r $latest_json ]]; then
    bad_check backup-latest "读不到备份清单：$latest_json"
    return
  fi
  mtime=$(stat -c %Y "$latest_json")
  now=$(date -u +%s)
  age=$((now - mtime))
  if ((age > latest_max_age)); then
    bad_check backup-latest "备份清单超过 26 小时未更新：$latest_json（$((age / 3600)) 小时）"
    return
  fi
  ok_check backup-latest
}

check_disk() {
  local key=$1 path=$2 percent
  if [[ ! -d $path ]]; then
    bad_check "$key" "磁盘检查路径不存在：$path"
    return
  fi
  percent=$(df -P "$path" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
  if [[ ! $percent =~ ^[0-9]+$ ]]; then
    bad_check "$key" "读不到磁盘使用率：$path"
    return
  fi
  if ((percent >= disk_warn_percent)); then
    bad_check "$key" "磁盘使用率 ${percent}% 达到阈值 ${disk_warn_percent}%：$path"
    return
  fi
  ok_check "$key"
}

check_certificate() {
  local ends seconds days
  if [[ ! -r $cert_file ]]; then
    bad_check cert "读不到证书：$cert_file"
    return
  fi
  if ! ends=$(openssl x509 -enddate -noout -in "$cert_file" 2>&1); then
    bad_check cert "无法解析证书：$cert_file（$ends）"
    return
  fi
  seconds=$(date -u -d "${ends#notAfter=}" +%s 2>/dev/null) || {
    bad_check cert "无法解析证书到期时间：$ends"
    return
  }
  days=$(((seconds - $(date -u +%s)) / 86400))
  if ((days < cert_warn_days)); then
    bad_check cert "证书剩余 ${days} 天，低于阈值 ${cert_warn_days} 天：$cert_file"
    return
  fi
  ok_check cert
}

check_journal() {
  local bytes
  bytes=$(du -sb /var/log/journal 2>/dev/null | awk '{ print $1 }')
  [[ -n $bytes ]] || bytes=0
  if ((bytes >= journal_warn_bytes)); then
    bad_check journal "journal 占用 ${bytes} 字节，达到阈值 ${journal_warn_bytes}：/var/log/journal"
    return
  fi
  ok_check journal
}

check_http worker 'Worker /health' "$worker_url"
check_http api 'API /api/health' "$api_url"

if pg_isready -q; then
  ok_check postgres
else
  bad_check postgres 'PostgreSQL 不可用（pg_isready 失败）'
fi

check_backup_freshness
check_disk disk-root /
check_disk disk-var /var/lib/fs-billing
check_disk disk-backups /root/backups
check_certificate
check_journal

if ((${#due_messages[@]} > 0)); then
  message=$(printf '%s\n\n' "${due_messages[@]}")
  if "$notify" --subject "【FS-Billing】服务器 B 体检失败（${#due_messages[@]} 项）" --body "$message"; then
    now=$(date -u +%s)
    for key in "${due_keys[@]}"; do
      printf '%s\n' "$now" >"$state_dir/$key"
    done
  else
    log '体检失败，但通知邮件发送失败'
  fi
fi

if ((failures > 0)); then
  exit 1
fi
