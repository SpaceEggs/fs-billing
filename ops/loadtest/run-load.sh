#!/usr/bin/env bash
# 阶段 10 验收 4 的压测驱动：SIPp 同时扮演客户（UAC，uac-load.xml）与模拟上游（UAS，
# uas-carrier.xml）。FreeSWITCH 的上游网关必须指向本脚本启动的 UAS，脚本从不拨真实线路。
#
# 节奏（设计 §4）：预检 → 1 分钟冒烟 2 cps → 10 分钟中压 5 cps → 30 分钟正式 10 cps
# （-l 50 -m 18000）→ 静置等补推与扣费 → verify-load.ts。
# 另有一次补充模式（决定 8）：50 路各保持 3 分钟。
#
# 所有速率、时长、主机都能用参数或环境变量覆盖，所以在开发机低速率跑同一个脚本、
# 在真实 SIPp 主机上全速跑。默认值只指向回环地址。
#
# 常用环境变量（同名参数优先）：
#   DATABASE_URL          owner 或只读连接；只用于预检、静置轮询与 verify-load.ts
#   API_HEALTH_URL        API 健康检查；置空跳过（压测热路径不经过 API）
#   WORKER_HEALTH_URL     Worker 健康检查
#   SIPP_BIN              SIPp 可执行文件，默认 sipp
#   SIPP_DOCKER_IMAGE     非空时用 `docker run --network host` 跑该镜像（镜像入口是 sipp）
#   RETRY_DIR             A 上 /var/lib/freeswitch/cdr/retry，提供给 verify-load.ts 检查
#   LOADTEST_TENANT       测试租户编码，默认 LOADTEST
#   FS_HOST / FS_PORT     FreeSWITCH SIP 地址，默认 127.0.0.1:5060
#   UAS_IP / UAS_PORT     模拟上游监听地址，默认 127.0.0.1:5090
#   UAC_IP / UAC_PORT     客户侧本地地址，默认 127.0.0.2:5062
#   FULL_RATE / FULL_SECONDS / FULL_CONCURRENCY 等，见 usage
set +x
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$script_dir/../.." && pwd)

usage() {
  cat <<'USAGE'
用法：ops/loadtest/run-load.sh [选项]

  --out DIR                 输出目录（默认 /tmp/fsb-loadtest-<UTC 时间>）
  --tenant CODE             测试租户编码（默认 LOADTEST）
  --mode load|long          load：冒烟/中压/正式；long：50 路各保持 3 分钟（决定 8）
  --fs HOST:PORT            FreeSWITCH SIP 地址
  --uas HOST:PORT           模拟上游监听地址
  --uac-ip IP               客户侧本地地址
  --env-file PATH           读取 DATABASE_URL 等变量的文件（默认仓库根 .env）
  --api-health URL          API 健康检查地址；传空串跳过
  --worker-health URL       Worker 健康检查地址
  --retry-dir DIR           A 上的 retry 目录，交给 verify-load.ts 检查
  --sipp-docker-image IMAGE 用 `docker run --network host` 跑该 SIPp 镜像（镜像入口是 sipp）
  --sipp-bin PATH           SIPp 可执行文件（默认 sipp；两者都不给时用 PATH 里的 sipp）
  --psql-docker-image IMAGE 本机没有 psql 时，用该镜像的 psql 做只读查询（仅冒烟用）
  --skip-smoke              跳过 1 分钟冒烟
  --skip-medium             跳过 10 分钟中压
  --skip-full               跳过正式 30 分钟
  --no-settle               跳过静置
  --no-verify               跳过最后的 verify-load.ts（只用于排查脚本）
  --smoke-rate N            冒烟每秒呼叫数（默认 2）
  --smoke-seconds N         冒烟时长（默认 60）
  --medium-rate N           中压每秒呼叫数（默认 5）
  --medium-seconds N        中压时长（默认 600）
  --full-rate N             正式每秒呼叫数（默认 10）
  --full-seconds N          正式时长（默认 1800）
  --full-concurrency N      正式并发上限（默认 50）
  --settle-seconds N        静置最长等待（默认 600）
  --long-calls N            补充模式呼叫数（默认 50）
  --long-hold-seconds N     补充模式每通保持秒数（默认 180）
  -h, --help                显示本帮助

退出码：0 全部通过；1 有核对失败；2 参数或环境错误。
USAGE
}

out=${LOADTEST_OUT:-/tmp/fsb-loadtest-$(date -u +%Y%m%dT%H%M%S)-$$}
tenant=${LOADTEST_TENANT:-LOADTEST}
mode=${LOADTEST_MODE:-load}
env_file=${LOADTEST_ENV_FILE:-$root/.env}
fs_host=${FS_HOST:-127.0.0.1}
fs_port=${FS_PORT:-5060}
uas_ip=${UAS_IP:-127.0.0.1}
uas_port=${UAS_PORT:-5090}
uac_ip=${UAC_IP:-127.0.0.2}
uac_port=${UAC_PORT:-5062}
media_ip=${MEDIA_IP:-$uac_ip}
media_port=${MEDIA_PORT:-6000}
uas_media_port=${UAS_MEDIA_PORT:-7000}
api_health=${API_HEALTH_URL-http://127.0.0.1:3000/api/health}
worker_health=${WORKER_HEALTH_URL-http://127.0.0.1:3001/health}
retry_dir=${RETRY_DIR:-}
sipp_bin=${SIPP_BIN:-sipp}
sipp_docker_image=${SIPP_DOCKER_IMAGE:-}
psql_docker_image=${PSQL_DOCKER_IMAGE:-}
skip_smoke=0
skip_medium=0
skip_full=0
do_settle=1
do_verify=1
smoke_rate=${SMOKE_RATE:-2}
smoke_seconds=${SMOKE_SECONDS:-60}
medium_rate=${MEDIUM_RATE:-5}
medium_seconds=${MEDIUM_SECONDS:-600}
full_rate=${FULL_RATE:-10}
full_seconds=${FULL_SECONDS:-1800}
full_concurrency=${FULL_CONCURRENCY:-50}
settle_seconds=${SETTLE_SECONDS:-600}
long_calls=${LONG_CALLS:-50}
long_hold_seconds=${LONG_HOLD_SECONDS:-180}
disk_min_mb=${DISK_MIN_MB:-2048}
min_balance=${MIN_BALANCE:-0}

while (($# > 0)); do
  case "$1" in
    --out) out=${2:?--out 需要参数}; shift 2 ;;
    --tenant) tenant=${2:?--tenant 需要参数}; shift 2 ;;
    --mode) mode=${2:?--mode 需要参数}; shift 2 ;;
    --fs)
      fs_host=${2%:*}; fs_port=${2##*:}
      [[ $fs_host != "$2" && $fs_port =~ ^[0-9]+$ ]] || { echo '--fs 需要 HOST:PORT' >&2; exit 2; }
      shift 2 ;;
    --uas)
      uas_ip=${2%:*}; uas_port=${2##*:}
      [[ $uas_ip != "$2" && $uas_port =~ ^[0-9]+$ ]] || { echo '--uas 需要 HOST:PORT' >&2; exit 2; }
      shift 2 ;;
    --uac-ip) uac_ip=${2:?--uac-ip 需要参数}; media_ip=$uac_ip; shift 2 ;;
    --env-file) env_file=${2:?--env-file 需要参数}; shift 2 ;;
    --api-health) api_health=${2-}; shift 2 ;;
    --worker-health) worker_health=${2-}; shift 2 ;;
    --retry-dir) retry_dir=${2:?--retry-dir 需要参数}; shift 2 ;;
    --sipp-docker-image) sipp_docker_image=${2:?--sipp-docker-image 需要参数}; shift 2 ;;
    --sipp-bin) sipp_bin=${2:?--sipp-bin 需要参数}; shift 2 ;;
    --psql-docker-image) psql_docker_image=${2:?--psql-docker-image 需要参数}; shift 2 ;;
    --skip-smoke) skip_smoke=1; shift ;;
    --skip-medium) skip_medium=1; shift ;;
    --skip-full) skip_full=1; shift ;;
    --no-settle) do_settle=0; shift ;;
    --no-verify) do_verify=0; shift ;;
    --smoke-rate) smoke_rate=${2:?--smoke-rate 需要参数}; shift 2 ;;
    --smoke-seconds) smoke_seconds=${2:?--smoke-seconds 需要参数}; shift 2 ;;
    --medium-rate) medium_rate=${2:?--medium-rate 需要参数}; shift 2 ;;
    --medium-seconds) medium_seconds=${2:?--medium-seconds 需要参数}; shift 2 ;;
    --full-rate) full_rate=${2:?--full-rate 需要参数}; shift 2 ;;
    --full-seconds) full_seconds=${2:?--full-seconds 需要参数}; shift 2 ;;
    --full-concurrency) full_concurrency=${2:?--full-concurrency 需要参数}; shift 2 ;;
    --settle-seconds) settle_seconds=${2:?--settle-seconds 需要参数}; shift 2 ;;
    --long-calls) long_calls=${2:?--long-calls 需要参数}; shift 2 ;;
    --long-hold-seconds) long_hold_seconds=${2:?--long-hold-seconds 需要参数}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "失败：$*" >&2; exit 2; }
warn() { echo "注意：$*" >&2; }
note() { printf '%s\n' "$*" | tee -a "$out/run.log"; }
now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

[[ $tenant =~ ^[A-Za-z0-9_]{1,32}$ ]] || die '租户编码只允许 1–32 位字母、数字、下划线'
[[ $mode == load || $mode == long ]] || die '--mode 只能是 load 或 long'
for value in "$smoke_rate" "$smoke_seconds" "$medium_rate" "$medium_seconds" \
  "$full_rate" "$full_seconds" "$full_concurrency" "$settle_seconds" \
  "$long_calls" "$long_hold_seconds" "$uas_port" "$uac_port" "$media_port" "$uas_media_port"; do
  [[ $value =~ ^[0-9]+$ ]] || die "数字参数不合法：$value"
done
((smoke_rate > 0 && smoke_seconds > 0 && medium_rate > 0 && medium_seconds > 0)) || die '冒烟/中压速率与时长必须大于 0'
((full_rate > 0 && full_seconds > 0 && full_concurrency > 0)) || die '正式阶段速率、时长、并发必须大于 0'
((long_calls > 0 && long_hold_seconds > 0)) || die '补充模式的呼叫数与保持时长必须大于 0'
[[ $uas_ip != "$fs_host" || $uas_port != "$fs_port" ]] || die 'UAS 与 FreeSWITCH 不能是同一个地址端口'

if [[ -f $env_file ]]; then
  set -a
  # shellcheck source=/dev/null # 运行期指定的 env 文件，静态检查时可能不存在
  . "$env_file"
  set +a
fi

mkdir -p "$out"
out=$(cd "$out" && pwd)
chmod 0700 "$out" 2>/dev/null || true
: > "$out/run.log"
printf 'stage\tstart_utc\tend_utc\tcalls\trate\tconcurrency\tscenario\n' > "$out/stages.tsv"

if [[ -n $sipp_docker_image ]]; then
  SIPP=(docker run --rm --network host -v "$script_dir:/scenarios:ro" -v "$out:/logs" "$sipp_docker_image")
  scenario_prefix=/scenarios
  log_prefix=/logs
else
  command -v "$sipp_bin" >/dev/null || die "找不到 SIPp：$sipp_bin（或用 SIPP_DOCKER_IMAGE）"
  SIPP=("$sipp_bin")
  scenario_prefix=$script_dir
  log_prefix=$out
fi

uas_pid=
uas_container=
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n $uas_container ]]; then docker rm -f "$uas_container" >/dev/null 2>&1; fi
  if [[ -n $uas_pid ]]; then
    kill "$uas_pid" 2>/dev/null
    wait "$uas_pid" 2>/dev/null
  fi
  printf '输出目录 %s\n' "$out"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_uas() {
  if ((uas_port > 0)) && command -v ss >/dev/null 2>&1; then
    if ss -lun 2>/dev/null | awk '{print $5}' | grep -qE "[:.]$uas_port\$"; then
      die "UAS 端口 $uas_port 已被占用；停掉占用者或改用 --uas"
    fi
  fi
  local -a args=(-sf "$scenario_prefix/uas-carrier.xml" -i "$uas_ip" -p "$uas_port"
    -mi "$uas_ip" -mp "$uas_media_port" -nostdin -trace_err
    -error_file "$log_prefix/uas-errors.log")
  if [[ -n $sipp_docker_image ]]; then
    uas_container="p10-load-uas-$$"
    docker run --rm --name "$uas_container" --network host \
      -v "$script_dir:/scenarios:ro" -v "$out:/logs" "$sipp_docker_image" \
      "${args[@]}" > "$out/uas.log" 2>&1 &
  else
    "$sipp_bin" "${args[@]}" > "$out/uas.log" 2>&1 &
  fi
  uas_pid=$!
  sleep 2
  kill -0 "$uas_pid" 2>/dev/null || die '模拟上游 UAS 启动失败，见 uas.log'
  note "模拟上游已监听 $uas_ip:$uas_port（pid $uas_pid），FreeSWITCH 的 upstream 网关必须指向这里"
}

check_url() {
  local label=$1 url=$2
  [[ -z $url ]] && { warn "$label 健康检查已跳过（URL 为空）"; return 0; }
  local body
  if ! body=$(curl --noproxy '*' -fsS --max-time 5 "$url" 2>&1); then
    die "$label 健康检查失败：$url：$body"
  fi
  note "$label 健康检查通过：$url → $body"
}

db_scalar() {
  if [[ -n $psql_docker_image ]]; then
    docker run --rm --network host "$psql_docker_image" \
      psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"
  else
    psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 -c "$1"
  fi
}

preflight() {
  note '== 预检 =='
  check_url API "$api_health"
  check_url Worker "$worker_health"
  [[ -d $out ]] || die "输出目录不存在：$out"
  local free_mb
  free_mb=$(df -Pk "$out" | awk 'NR==2 {print $4}')
  [[ $free_mb =~ ^[0-9]+$ ]] || die '读不到磁盘余量'
  ((free_mb >= disk_min_mb)) || die "磁盘余量 ${free_mb} MB 小于 ${disk_min_mb} MB"
  note "磁盘余量 ${free_mb} MB（下限 ${disk_min_mb} MB）"

  if [[ -z ${DATABASE_URL:-} ]]; then
    die '需要 DATABASE_URL（只读即可）做租户余额预检、静置轮询与 verify-load.ts'
  fi
  if [[ -z $psql_docker_image ]]; then
    command -v psql >/dev/null || die '找不到 psql；或用 --psql-docker-image'
  fi
  local facts
  facts=$(db_scalar "select t.id::text || E'\t' || t.currency || E'\t' || t.status || E'\t' || t.overdraft_limit::text || E'\t' || coalesce(b.balance, 0)::text from tenants t left join tenant_balances b on b.tenant_id = t.id where upper(t.code) = upper('$tenant')")
  [[ -n $facts ]] || die "数据库里没有租户 $tenant"
  local id currency status overdraft balance
  IFS=$'\t' read -r id currency status overdraft balance <<<"$facts"
  [[ $status == active ]] || die "租户 $tenant 状态为 $status，不是 active"
  awk -v b="$balance" -v m="$min_balance" 'BEGIN { exit !(b > m) }' ||
    die "租户 $tenant 余额 $balance 不大于 $min_balance；先充值再压测"
  note "租户 $tenant：id=$id，币种=$currency，余额=$balance，透支额度=$overdraft"
  printf '%s\n' "$id" > "$out/tenant-id.txt"
}

run_stage() {
  local name=$1 rate=$2 seconds=$3 concurrency=$4 scenario=$5
  local calls=$((rate * seconds))
  local start end
  start=$(now_utc)
  note "开始 $name：${rate} cps × ${seconds}s = ${calls} 通，并发上限 ${concurrency}"
  local timeout=$((seconds + 600))s
  "${SIPP[@]}" "$fs_host:$fs_port" -sf "$scenario_prefix/$scenario" \
    -inf "$scenario_prefix/destinations.csv" \
    -i "$uac_ip" -p "$uac_port" -mi "$media_ip" -mp "$media_port" \
    -m "$calls" -r "$rate" -rp 1000 -l "$concurrency" -nostdin -timeout "$timeout" \
    -trace_stat -stf "$log_prefix/$name-stats.csv" \
    -trace_err -error_file "$log_prefix/$name-errors.log" \
    > "$out/$name.log" 2>&1 || die "$name 的 SIPp 退出非零，见 $out/$name.log"
  end=$(now_utc)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$start" "$end" "$calls" "$rate" "$concurrency" "$scenario" >> "$out/stages.tsv"
  note "完成 $name：$start → $end"
  sipp_logs+=("$out/$name.log")
}

run_long_stage() {
  local hold_ms=$((long_hold_seconds * 1000))
  local start end
  local generated=$out/uac-long.xml
  sed "s#<pause distribution=\"uniform\" min=\"2000\" max=\"8000\" />#<pause milliseconds=\"$hold_ms\" />#" \
    "$script_dir/uac-load.xml" > "$generated"
  grep -q "<pause milliseconds=\"$hold_ms\" />" "$generated" ||
    die '生成 3 分钟保持场景失败：uac-load.xml 里的 pause 行变了'
  local scenario=$generated
  if [[ -n $sipp_docker_image ]]; then scenario=$log_prefix/uac-long.xml; fi
  start=$(now_utc)
  note "补充模式：${long_calls} 路同时起呼，每通保持 ${long_hold_seconds}s"
  "${SIPP[@]}" "$fs_host:$fs_port" -sf "$scenario" \
    -inf "$scenario_prefix/destinations.csv" \
    -i "$uac_ip" -p "$uac_port" -mi "$media_ip" -mp "$media_port" \
    -m "$long_calls" -r "$long_calls" -rp 1000 -l "$long_calls" -nostdin \
    -timeout "$((long_hold_seconds + 300))s" \
    -trace_stat -stf "$log_prefix/long-stats.csv" \
    -trace_err -error_file "$log_prefix/long-errors.log" \
    > "$out/long.log" 2>&1 || die "补充模式的 SIPp 退出非零，见 $out/long.log"
  end=$(now_utc)
  printf 'long\t%s\t%s\t%s\t%s\t%s\t%s\n' "$start" "$end" "$long_calls" "$long_calls" "$long_calls" 'uac-long.xml' >> "$out/stages.tsv"
  note "补充模式完成：$start → $end"
  sipp_logs+=("$out/long.log")
}

settle() {
  note "== 静置（最多 ${settle_seconds}s，等补推与扣费队列清空）=="
  local deadline=$((SECONDS + settle_seconds))
  local pending uncharged quiet=0
  while ((SECONDS < deadline)); do
    pending=$(db_scalar "select count(*) from pgboss.job where name = 'charge-cdr' and state in ('created', 'retry', 'active')" 2>/dev/null || true)
    uncharged=$(db_scalar "select count(*) from cdrs c where c.tenant_id = (select id from tenants where upper(code) = upper('$tenant')) and c.started_at >= '$window_start' and c.answered_at is not null and c.charge <> 0 and not exists (select 1 from ledger_entries l where l.tenant_id = c.tenant_id and l.kind = 'call_charge' and l.idempotency_key = 'call:' || c.call_uuid::text)" 2>/dev/null || true)
    pending=${pending:-0}
    uncharged=${uncharged:-0}
    if [[ $pending == 0 && $uncharged == 0 ]]; then
      quiet=$((quiet + 1))
      if ((quiet >= 3)); then
        note '补推与扣费队列已清空'
        return 0
      fi
    else
      quiet=0
    fi
    sleep 5
  done
  warn "静置 ${settle_seconds}s 后仍有未完成项（pg-boss=${pending:-?}，未扣费=${uncharged:-?}）；verify-load.ts 会判定失败"
}

note "运行参数：mode=$mode tenant=$tenant fs=$fs_host:$fs_port uas=$uas_ip:$uas_port uac=$uac_ip out=$out"
start_uas
preflight

sipp_logs=()
window_start=$(now_utc)
if [[ $mode == long ]]; then
  run_long_stage
else
  if ((!skip_smoke)); then run_stage smoke "$smoke_rate" "$smoke_seconds" 10 uac-load.xml; fi
  if ((!skip_medium)); then run_stage medium "$medium_rate" "$medium_seconds" 50 uac-load.xml; fi
  if ((!skip_full)); then run_stage full "$full_rate" "$full_seconds" "$full_concurrency" uac-load.xml; fi
fi
window_end=$(now_utc)
printf '%s\t%s\n' "$window_start" "$window_end" > "$out/window.tsv"
note "呼叫窗口 $window_start → $window_end"

if ((do_settle)); then settle; fi

if ((do_verify)); then
  note '== 核对 =='
  verify_args=(scripts/verify-load.ts --tenant "$tenant" --since "$window_start" --until "$window_end")
  for log in "${sipp_logs[@]}"; do verify_args+=(--sipp-log "$log"); done
  if [[ -n $retry_dir ]]; then verify_args+=(--retry-dir "$retry_dir"); fi
  (cd "$root" && pnpm --filter @fs-billing/db exec tsx --env-file-if-exists="$env_file" \
    "${verify_args[@]}") | tee "$out/verify-load.txt"
fi

note '压测脚本结束'
