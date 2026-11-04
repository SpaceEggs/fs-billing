#!/usr/bin/env bash
# 压测期间每 5 秒采样一次资源，写 CSV（设计 §4「节奏」）。在服务器 B 上运行：
#
#   ops/loadtest/sample-resources.sh --out /tmp/load-resources.csv
#
# 列：UTC 时间、已运行秒数、CPU 使用率（两次采样的差值）、1 分钟负载、内存已用/可用、
# 数据库连接数、pg-boss 积压（created/retry/active）、最近一个采样区间的 journal 错误行数。
# 数据库两列从 DATABASE_URL 读取（只做 SELECT）；没设时写 `-`，其余列照常。
# Ctrl-C 或 SIGTERM 结束；正常跑完 --duration 也会写最后一行并退出 0。
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：ops/loadtest/sample-resources.sh [选项]

  --out FILE         CSV 输出（默认 /tmp/fsb-load-resources-<UTC 时间>.csv）
  --interval N       采样间隔秒（默认 5）
  --duration N       总时长秒；0 表示一直采到收到信号（默认 0）
  -h, --help         显示本帮助

环境变量：DATABASE_URL（可选，只读查询 pg_stat_activity 与 pgboss.job）。
USAGE
}

out=/tmp/fsb-load-resources-$(date -u +%Y%m%dT%H%M%S)-$$.csv
interval=5
duration=0
env_file=

while (($# > 0)); do
  case "$1" in
    --out) out=${2:?--out 需要参数}; shift 2 ;;
    --interval) interval=${2:?--interval 需要参数}; shift 2 ;;
    --duration) duration=${2:?--duration 需要参数}; shift 2 ;;
    --env-file) env_file=${2:?--env-file 需要参数}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ ! $interval =~ ^[0-9]+$ ]] || ((interval <= 0)); then
  echo '间隔必须是正整数秒' >&2
  exit 2
fi
[[ $duration =~ ^[0-9]+$ ]] || { echo '时长必须是整数秒' >&2; exit 2; }

if [[ -n $env_file && -f $env_file ]]; then
  set -a
  # shellcheck source=/dev/null # 运行期指定的 env 文件，静态检查时可能不存在
  . "$env_file"
  set +a
fi

mkdir -p "$(dirname "$out")"
printf 'ts_utc\telapsed_s\tcpu_pct\tload1\tmem_used_mb\tmem_avail_mb\tpg_connections\tpgboss_backlog\tjournal_errors_interval\n' > "$out"

cpu_busy=0
cpu_total=0
start_second=$SECONDS
running=1
trap 'running=0' INT TERM

snapshot_cpu() {
  local user nice system idle iowait irq softirq steal total
  read -r _ user nice system idle iowait irq softirq steal _ < /proc/stat
  total=$((user + nice + system + idle + iowait + irq + softirq + steal))
  CPU_TOTAL_NOW=$total
  CPU_BUSY_NOW=$((total - idle - iowait))
}

db_columns() {
  if [[ -z ${DATABASE_URL:-} ]] || ! command -v psql >/dev/null 2>&1; then
    printf '%s\t%s' '-' '-'
    return 0
  fi
  local row
  if ! row=$(psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "select (select count(*) from pg_stat_activity where datname = current_database()) || E'\t' || (select count(*) from pgboss.job where state in ('created', 'retry', 'active'))" 2>/dev/null); then
    printf '%s\t%s' '-' '-'
    return 0
  fi
  printf '%s' "$row"
}

journal_errors() {
  local count
  if ! command -v journalctl >/dev/null 2>&1; then
    printf '0'
    return 0
  fi
  count=$(journalctl -u fs-billing-api -u fs-billing-worker --since "${interval} seconds ago" \
    --no-pager -p err --output=cat 2>/dev/null | wc -l | tr -d ' ') || count=0
  printf '%s' "${count:-0}"
}

printf '开始采样：%s，间隔 %ss，时长 %s\n' "$out" "$interval" "$duration" >&2
while ((running)); do
  snapshot_cpu
  local_cpu=0
  if ((cpu_total > 0)); then
    delta_total=$((CPU_TOTAL_NOW - cpu_total))
    delta_busy=$((CPU_BUSY_NOW - cpu_busy))
    if ((delta_total > 0)); then
      local_cpu=$(awk -v b="$delta_busy" -v t="$delta_total" 'BEGIN { printf "%.1f", (100 * b) / t }')
    fi
  fi
  cpu_busy=$CPU_BUSY_NOW
  cpu_total=$CPU_TOTAL_NOW

  load1=$(awk '{print $1}' /proc/loadavg 2>/dev/null || printf '0')
  mem_used=0
  mem_avail=0
  if [[ -r /proc/meminfo ]]; then
    read -r mem_used mem_avail < <(awk '
      /^MemTotal:/ { total = $2 }
      /^MemAvailable:/ { available = $2 }
      END { printf "%d %d\n", (total - available) / 1024, available / 1024 }
    ' /proc/meminfo)
  fi
  db=$(db_columns)
  errors=$(journal_errors)
  printf '%s\t%d\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$((SECONDS - start_second))" \
    "$local_cpu" "$load1" "$mem_used" "$mem_avail" "$db" "$errors" >> "$out"
  if ((duration > 0 && SECONDS - start_second >= duration)); then
    break
  fi
  sleep "$interval"
done

printf '采样结束：%s\n' "$out" >&2
