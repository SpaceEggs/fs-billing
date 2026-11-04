#!/usr/bin/env bash
# 从零部署的用时记录。每调用一次 mark，就追加一行「步骤、起止时间、秒数」；
# 起点是第一次 mark（“root 能 SSH 登录”），终点是冒烟通过。
# run 单独记录一条命令的脚本耗时，与人工等待/输入分开；两者写同一个 TSV。
#
#   stopwatch.sh mark "步骤名"
#   stopwatch.sh mark --kind script "步骤名"
#   stopwatch.sh run "数据库迁移" -- pnpm db:migrate
#   stopwatch.sh show
set -euo pipefail

log_file=/var/log/fs-billing-deploy-time.tsv

usage() {
  cat <<'EOF'
用法：
  stopwatch.sh mark [--kind manual|script] <步骤名>
  stopwatch.sh run <步骤名> -- <命令> [参数...]
  stopwatch.sh show

记录写入 /var/log/fs-billing-deploy-time.tsv。
mark 的区间从上一行结束时间到本次调用；run 只记录该命令本身。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
esac

[[ $EUID -eq 0 ]] || fail '必须以 root 执行，记录写在 /var/log'

ensure_log() {
  if [[ ! -e $log_file ]]; then
    umask 077
    printf 'kind\tstep\tstarted_at\tended_at\tseconds\n' >"$log_file"
    chmod 0644 "$log_file"
  fi
}

append_row() {
  local kind=$1 step=$2 started=$3 ended=$4 seconds=$5
  printf '%s\t%s\t%s\t%s\t%s\n' "$kind" "$step" "$started" "$ended" "$seconds" \
    >>"$log_file"
}

clean_step() {
  local step=$1
  step=${step//$'\t'/ }
  step=${step//$'\n'/ }
  printf '%s' "$step"
}

now_iso() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

case ${1:-} in
  show)
    ensure_log
    cat "$log_file"
    exit 0
    ;;
  mark | run) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

subcommand=$1
shift
ensure_log

if [[ $subcommand == mark ]]; then
  kind=manual
  if [[ ${1:-} == --kind ]]; then
    kind=${2:-}
    shift 2 || true
  fi
  [[ $kind == manual || $kind == script ]] || fail "kind 只能是 manual 或 script：$kind"
  step=$(clean_step "${1:-}")
  (($#)) && shift
  if (($#)); then
    step=$(clean_step "$step $*")
  fi
  [[ -n $step ]] || fail '必须给步骤名'

  ended=$(now_iso)
  ended_epoch=$(date -u -d "$ended" +%s)
  started=$ended
  started_epoch=$ended_epoch
  if [[ $(wc -l <"$log_file") -gt 1 ]]; then
    previous_end=$(tail -n 1 "$log_file" | cut -f4)
    if [[ -n $previous_end ]] && parsed=$(date -u -d "$previous_end" +%s 2>/dev/null); then
      started=$previous_end
      started_epoch=$parsed
    fi
  fi

  seconds=$((ended_epoch - started_epoch))
  ((seconds >= 0)) || seconds=0
  append_row "$kind" "$step" "$started" "$ended" "$seconds"
  printf '%s\t%s\t%ss\n' "$kind" "$step" "$seconds"
  exit 0
fi

# run：只给被包裹的命令计时，不接续 mark 的区间。
step=$(clean_step "${1:-}")
[[ -n $step ]] || fail 'run 必须给步骤名'
shift
[[ ${1:-} == -- ]] && shift
(($#)) || fail 'run 必须在 -- 之后给出命令'

started=$(now_iso)
started_epoch=$(date -u -d "$started" +%s)
if "$@"; then
  status=0
else
  status=$?
fi
ended=$(now_iso)
ended_epoch=$(date -u -d "$ended" +%s)
seconds=$((ended_epoch - started_epoch))
((seconds >= 0)) || seconds=0
append_row script "$step" "$started" "$ended" "$seconds"
printf 'script\t%s\t%ss\n' "$step" "$seconds"
exit "$status"
