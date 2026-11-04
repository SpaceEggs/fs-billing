#!/usr/bin/env bash
# 阶段 10 验收 5、6 的故障演练。两个子命令都操作服务器 B 上的 systemd 与 FreeSWITCH：
#
#   drill.sh restart-front   压测第 8 分钟：重启 fs-billing-api，10 秒后重启 nginx（Web）
#   drill.sh stop-worker     压测第 15 分钟：停 fs-billing-worker 60 秒，第 5 秒起一通
#                            120 秒探针呼叫，读 execute_on_answer 应为
#                            `sched_hangup +1800 ALLOTTED_TIMEOUT`
#
# 脚本必须与 30 分钟压测同一次运行；它不启动压测，也不改 SIPp 场景。时间线写到
# <out>/timeline.tsv（UTC），curl 探测与 journal 摘录同目录。
# 服务器地址、密钥都不出现在脚本里；FreeSWITCH 命令经 fs_cli（默认本机，设置
# FS_CLI_SSH 时经 ssh 在 A 上执行），systemd 经本机 systemctl。
set +x
set -euo pipefail

usage() {
  cat <<'USAGE'
用法：
  ops/loadtest/drill.sh restart-front [选项]
  ops/loadtest/drill.sh stop-worker  [选项]

restart-front：
  --out DIR             输出目录（默认 /tmp/fsb-drill-restart-front-<UTC 时间>）
  --probe-url URL       每秒探测的地址（默认 https://127.0.0.1/api/health，经 nginx）
  --no-insecure         探测时不加 curl -k（默认加，自签证书阶段）
  --sipp-stats FILE     正在跑的 SIPp -trace_stat 文件；按行号切出演练时段
  --api-unit UNIT       systemd 单元（默认 fs-billing-api）
  --web-unit UNIT       Web 所在的 nginx 单元（默认 nginx）
  --settle-seconds N    重启后等健康恢复的上限（默认 90）

stop-worker：
  --out DIR             输出目录（默认 /tmp/fsb-drill-stop-worker-<UTC 时间>）
  --probe-dest NUMBER   探针被叫号码（默认 8613800000001，合成号码）
  --probe-tenant CODE   探针的 billing_tenant（默认 LOADTEST）
  --probe-hold-seconds N 探针通话时长（默认 120）
  --worker-unit UNIT    systemd 单元（默认 fs-billing-worker）
  --worker-settle-seconds N 重启后等健康恢复的上限（默认 90）
  --sipp-stats FILE     正在跑的 SIPp -trace_stat 文件；按行号切出演练时段

环境变量：SYSTEMCTL、JOURNALCTL、FS_CLI 可覆盖命令，默认 systemctl、journalctl、fs_cli。
stop-worker 既管理本机（B）的 Worker，也要连 A 的 event socket；A 的防火墙
（ops/firewall/nftables-a.conf）不对外开放 event socket，B 不能直连。设置
FS_CLI_SSH=<user@A> 时，脚本用 `ssh -- "$FS_CLI_SSH" fs_cli -x "<命令>"` 在 A 上执行；
不设置时直接跑本机 fs_cli（操作员就在 A 上时）。ssh 认证用密钥，脚本里没有任何密码。
以 root 运行；脚本不调用 sudo、不写任何密钥。
USAGE
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }
die() { echo "失败：$*" >&2; exit 2; }
warn() { echo "注意：$*" >&2; }

command_name=${1:-}
[[ $command_name == restart-front || $command_name == stop-worker ]] || {
  usage >&2
  exit 2
}
shift

out=
probe_url=https://127.0.0.1/api/health
insecure=1
sipp_stats=
api_unit=fs-billing-api
web_unit=nginx
worker_unit=fs-billing-worker
settle_seconds=90
probe_dest=8613800000001
probe_tenant=LOADTEST
probe_hold_seconds=120

while (($# > 0)); do
  case "$1" in
    --out) out=${2:?--out 需要参数}; shift 2 ;;
    --probe-url) probe_url=${2:?--probe-url 需要参数}; shift 2 ;;
    --no-insecure) insecure=0; shift ;;
    --sipp-stats) sipp_stats=${2:?--sipp-stats 需要参数}; shift 2 ;;
    --api-unit) api_unit=${2:?--api-unit 需要参数}; shift 2 ;;
    --web-unit) web_unit=${2:?--web-unit 需要参数}; shift 2 ;;
    --worker-unit) worker_unit=${2:?--worker-unit 需要参数}; shift 2 ;;
    --settle-seconds) settle_seconds=${2:?--settle-seconds 需要参数}; shift 2 ;;
    --probe-dest) probe_dest=${2:?--probe-dest 需要参数}; shift 2 ;;
    --probe-tenant) probe_tenant=${2:?--probe-tenant 需要参数}; shift 2 ;;
    --probe-hold-seconds) probe_hold_seconds=${2:?--probe-hold-seconds 需要参数}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $probe_dest =~ ^[1-9][0-9]{5,14}$ ]] || die '探针号码只接受 6–15 位、首位非零的合成号码'
[[ $probe_tenant =~ ^[A-Za-z0-9]+$ ]] || die '探针租户编码只允许字母与数字'
if [[ ! $probe_hold_seconds =~ ^[0-9]+$ ]] || ((probe_hold_seconds <= 0)); then
  die '探针时长必须是正整数秒'
fi
[[ $settle_seconds =~ ^[0-9]+$ ]] || die '等待秒数必须是整数'

out=${out:-/tmp/fsb-drill-$command_name-$(date -u +%Y%m%dT%H%M%S)-$$}
mkdir -p "$out"
chmod 0700 "$out" 2>/dev/null || true
printf 'step\tstart_utc\tend_utc\tdetail\n' > "$out/timeline.tsv"

emit() {
  local step=$1 start=$2 end=$3 detail=$4
  printf '%s\t%s\t%s\t%s\n' "$step" "$start" "$end" "$detail" >> "$out/timeline.tsv"
  printf '%s\t%s\t%s\t%s\n' "$step" "$start" "$end" "$detail"
}

systemctl_cmd=${SYSTEMCTL:-systemctl}
journalctl_cmd=${JOURNALCTL:-journalctl}
fs_cli_cmd=${FS_CLI:-fs_cli}
# stop-worker 在 B 上执行 systemctl；探针要碰 A 的 event socket。A 的防火墙不开放
# event socket，所以设置 FS_CLI_SSH 时经 ssh 在 A 上跑 fs_cli，未设置时假定操作员在 A 上。
fs_cli_ssh=${FS_CLI_SSH:-}
fscli() {
  if [[ -z $fs_cli_ssh ]]; then
    "$fs_cli_cmd" -x "$1"
    return 0
  fi
  # ssh 把参数拼成一行交给远端 shell，命令里的空格与 & 要整体转义后再传。
  ssh -- "$fs_cli_ssh" "$fs_cli_cmd -x $(printf '%q' "$1")"
}
command -v "$systemctl_cmd" >/dev/null || die '找不到 systemctl（本脚本只在服务器 B 上运行）'
command -v "$journalctl_cmd" >/dev/null || die '找不到 journalctl'

wait_active() {
  local unit=$1
  local seconds=$2
  local deadline=$((SECONDS + seconds))
  while ((SECONDS < deadline)); do
    if "$systemctl_cmd" is-active --quiet "$unit"; then return 0; fi
    sleep 1
  done
  return 1
}

restart_unit() {
  local unit=$1
  local start end
  start=$(now_utc)
  "$systemctl_cmd" restart "$unit"
  if ! wait_active "$unit" 60; then
    end=$(now_utc)
    emit "restart:$unit" "$start" "$end" 'restart 后 60 秒未 active'
    die "$unit 重启后没有变为 active"
  fi
  end=$(now_utc)
  emit "restart:$unit" "$start" "$end" 'systemctl restart 完成'
}

check_health() {
  local url=$1 deadline=$((SECONDS + settle_seconds))
  local -a curl_opts=()
  if ((insecure)); then curl_opts=(-k); fi
  while ((SECONDS < deadline)); do
    if curl --noproxy '*' "${curl_opts[@]}" -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

curl_probe_loop() {
  local stop_file=$1
  printf 'ts_utc\thttp_code\ttime_total_s\n' > "$out/curl.tsv"
  local -a curl_opts=(-sS -o /dev/null --max-time 3 -w '%{http_code} %{time_total}')
  if ((insecure)); then curl_opts=(-k "${curl_opts[@]}"); fi
  while [[ ! -f $stop_file ]]; do
    local ts result
    ts=$(now_utc)
    if ! result=$(curl --noproxy '*' "${curl_opts[@]}" "$probe_url" 2>/dev/null); then
      result='000 0'
    fi
    printf '%s\t%s\n' "$ts" "${result/ /$'\t'}" >> "$out/curl.tsv"
    sleep 1
  done
}

sipp_line_count() {
  if [[ -n $sipp_stats && -f $sipp_stats ]]; then wc -l < "$sipp_stats" | tr -d ' '; else printf '0'; fi
}

slice_sipp() {
  local from=$1 to=$2 destination=$3
  if [[ -z $sipp_stats || ! -f $sipp_stats ]]; then
    printf '未提供 --sipp-stats，未截取 SIPp 时段统计\n' > "$destination"
    return 0
  fi
  if ((to > from)); then
    sed -n "$((from + 1)),${to}p" "$sipp_stats" > "$destination"
  else
    : > "$destination"
  fi
}

journal_excerpt() {
  local since=$1 units=$2 destination=$3
  # units 以空格分隔；此处只拼固定的单元名，不接受外部命令。
  # shellcheck disable=SC2086 # 单元名列表需要分词传给 journalctl
  "$journalctl_cmd" --no-pager --since "$since" -u $units > "$destination" 2>&1 || true
}

run_restart_front() {
  command -v curl >/dev/null || die '找不到 curl'
  "$systemctl_cmd" cat "$api_unit" >/dev/null 2>&1 || die "没有 systemd 单元 $api_unit"
  "$systemctl_cmd" cat "$web_unit" >/dev/null 2>&1 || die "没有 systemd 单元 $web_unit"

  local started sipp_before stop_file probe_pid
  started=$(now_utc)
  sipp_before=$(sipp_line_count)
  stop_file=$out/curl.stop
  rm -f "$stop_file"
  # 异常退出时也停掉 curl 循环，避免留下后台进程。
  trap 'touch "$out/curl.stop" 2>/dev/null || true' EXIT
  curl_probe_loop "$stop_file" >/dev/null 2>&1 &
  probe_pid=$!

  sleep 5
  restart_unit "$api_unit"
  sleep 10
  restart_unit "$web_unit"

  if check_health "$probe_url"; then
    emit 'health-recovered' "$(now_utc)" "$(now_utc)" "$probe_url 恢复 200"
  else
    emit 'health-recovered' "$(now_utc)" "$(now_utc)" "$probe_url 在 ${settle_seconds}s 内未恢复"
    touch "$stop_file"
    wait "$probe_pid" 2>/dev/null || true
    die '重启后健康检查没有恢复'
  fi

  touch "$stop_file"
  wait "$probe_pid" 2>/dev/null || true
  local finished sipp_after
  finished=$(now_utc)
  sipp_after=$(sipp_line_count)
  slice_sipp "$sipp_before" "$sipp_after" "$out/sipp-window.csv"
  emit 'window' "$started" "$finished" "api=$api_unit web=$web_unit；SIPp 统计行 ${sipp_before}–${sipp_after}"

  awk -F '\t' 'NR > 1 && $2 != "200" { print }' "$out/curl.tsv" > "$out/curl-unavailable.tsv"
  {
    printf '不可用探测点（HTTP 非 200）：\n'
    cat "$out/curl-unavailable.tsv"
    printf '\n首个不可用：\n'
    awk -F '\t' 'NR > 1 && $2 != "200" { print; exit }' "$out/curl.tsv"
    printf '恢复为 200：\n'
    awk -F '\t' 'NR > 1 && $2 == "200" { last=$0 } END { print last }' "$out/curl.tsv"
  } > "$out/unavailable-window.txt"

  journal_excerpt "$started" "$api_unit $web_unit" "$out/journal.txt"
  "$systemctl_cmd" show -p NRestarts "$worker_unit" > "$out/worker-restarts.txt" 2>&1 || true
  printf '重启窗口内 Worker NRestarts：\n' >> "$out/worker-restarts.txt"

  local down_count
  down_count=$(awk -F '\t' 'NR > 1 && $2 != "200" { n++ } END { print n + 0 }' "$out/curl.tsv")
  printf 'curl 探测不可用点数：%s（后台短暂不可用属正常，不算失败）\n' "$down_count" | tee "$out/summary.txt"
  printf '判据：SIPp 失败数为 0、无 unverified 话单、话单数不少、Worker 未重启，由 verify-load.ts 核对。\n' >> "$out/summary.txt"
  if ((down_count == 0)); then
    warn '探测从未失败：确认 nginx 重启确实切断了当时的连接，或缩短探测间隔'
  fi
}

worker_stopped=0
probe_uuid=
cleanup_stop_worker() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n $probe_uuid ]]; then fscli "uuid_kill $probe_uuid" >/dev/null 2>&1; fi
  if ((worker_stopped)); then
    "$systemctl_cmd" start "$worker_unit" >/dev/null 2>&1
    wait_active "$worker_unit" 60 || true
  fi
  exit "$result"
}

run_stop_worker() {
  if [[ -n $fs_cli_ssh ]]; then
    command -v ssh >/dev/null || die '找不到 ssh（设置 FS_CLI_SSH 后需要它连服务器 A）'
  else
    command -v "$fs_cli_cmd" >/dev/null || die "找不到 $fs_cli_cmd（在服务器 A 上运行，或设置 FS_CLI_SSH）"
  fi
  "$systemctl_cmd" cat "$worker_unit" >/dev/null 2>&1 || die "没有 systemd 单元 $worker_unit"
  "$systemctl_cmd" is-active --quiet "$worker_unit" || die "$worker_unit 当前不是 active，演练没有意义"
  fscli 'status' >/dev/null 2>&1 || die 'fs_cli 连不上 FreeSWITCH'

  trap cleanup_stop_worker EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  local started sipp_before stop_start stop_end start_start start_end
  local probe_start probe_answered var_value probe_end stop_second probe_second
  local restarts_before restarts_after
  started=$(now_utc)
  sipp_before=$(sipp_line_count)
  restarts_before=$("$systemctl_cmd" show -p NRestarts "$worker_unit" 2>/dev/null || true)

  stop_start=$(now_utc)
  "$systemctl_cmd" stop "$worker_unit"
  stop_second=$SECONDS
  if wait_active "$worker_unit" 1; then
    die "$worker_unit 停止后仍是 active"
  fi
  worker_stopped=1
  stop_end=$(now_utc)
  emit 'worker-stop' "$stop_start" "$stop_end" "$worker_unit 已停止"

  sleep 5
  probe_start=$(now_utc)
  probe_second=$SECONDS
  probe_uuid=$(
    if command -v uuidgen >/dev/null 2>&1; then uuidgen
    else cat /proc/sys/kernel/random/uuid
    fi | tr '[:upper:]' '[:lower:]'
  )
  [[ $probe_uuid =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || die '生成探针 UUID 失败'
  # loopback 让探针走 billing context 的拨号计划与授权 Lua；直接 sofia/gateway 会绕过计费。
  if ! fscli "bgapi originate {origination_uuid=$probe_uuid,billing_tenant=$probe_tenant,originate_timeout=30,ignore_early_media=true}loopback/$probe_dest/billing &park()" > "$out/probe-originate.txt" 2>&1; then
    die "探针呼叫发起失败，见 $out/probe-originate.txt"
  fi
  emit 'probe-originate' "$probe_start" "$probe_start" "uuid=$probe_uuid dest=$probe_dest loopback/billing"

  local deadline=$((SECONDS + 60))
  local answer_stamp
  while ((SECONDS < deadline)); do
    answer_stamp=$(fscli "uuid_getvar $probe_uuid answer_stamp" 2>/dev/null || true)
    if [[ -n $answer_stamp && $answer_stamp != _undef_ && $answer_stamp != '-ERR'* ]]; then break; fi
    sleep 1
  done
  probe_answered=$(now_utc)
  if [[ -z ${answer_stamp:-} || $answer_stamp == _undef_ ]]; then
    emit 'probe-answer' "$probe_start" "$probe_answered" '60 秒内未接通'
    die '探针呼叫未接通，无法读取 execute_on_answer'
  fi
  var_value=$(fscli "uuid_getvar $probe_uuid execute_on_answer" 2>/dev/null || true)
  printf '%s\n' "$var_value" > "$out/probe-execute_on_answer.txt"
  emit 'probe-answer' "$probe_start" "$probe_answered" "answer_stamp=$answer_stamp execute_on_answer=$var_value"

  # 停机满 60 秒后恢复 Worker；探针继续持有到起呼后 120 秒再挂断。
  local worker_restart_at=$((stop_second + 60))
  while ((SECONDS < worker_restart_at)); do sleep 1; done
  start_start=$(now_utc)
  "$systemctl_cmd" start "$worker_unit"
  if ! wait_active "$worker_unit" 60; then
    start_end=$(now_utc)
    emit 'worker-start' "$start_start" "$start_end" '启动后 60 秒未 active'
    die "$worker_unit 未能重新启动"
  fi
  worker_stopped=0
  start_end=$(now_utc)
  emit 'worker-start' "$start_start" "$start_end" "$worker_unit 已启动"

  local probe_deadline=$((probe_second + probe_hold_seconds))
  while ((SECONDS < probe_deadline)); do sleep 1; done
  probe_end=$(now_utc)
  fscli "uuid_kill $probe_uuid" >/dev/null 2>&1 || true
  emit 'probe-hangup' "$probe_start" "$probe_end" "保持 ${probe_hold_seconds}s 后挂断"
  probe_uuid=

  restarts_after=$("$systemctl_cmd" show -p NRestarts "$worker_unit" 2>/dev/null || true)
  journal_excerpt "$started" "$worker_unit" "$out/journal.txt"
  slice_sipp "$sipp_before" "$(sipp_line_count)" "$out/sipp-window.csv"

  local exit_code=0
  if [[ $var_value != 'sched_hangup +1800 ALLOTTED_TIMEOUT' ]]; then
    printf '判据失败：execute_on_answer=%s，期望 sched_hangup +1800 ALLOTTED_TIMEOUT\n' "$var_value" | tee "$out/summary.txt"
    exit_code=1
  else
    printf '判据通过：execute_on_answer=%s\n' "$var_value" | tee "$out/summary.txt"
  fi
  printf 'Worker NRestarts：演练前 %s，演练后 %s（手工 stop/start 不算自动重启）\n' \
    "$restarts_before" "$restarts_after" >> "$out/summary.txt"
  printf '继续用 verify-load.ts 核对窗口内 cdrs、call_uuids、retry 与 auth_timeout 告警。\n' >> "$out/summary.txt"
  exit "$exit_code"
}

if [[ $command_name == restart-front ]]; then
  run_restart_front
else
  run_stop_worker
fi
