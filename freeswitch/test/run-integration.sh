#!/usr/bin/env bash
# Linux host 网络集成验证。保留既有开发数据，只调整 FSI 测试租户。
set +x
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
build=false
log_dir=${FS_INTEGRATION_LOG_DIR:-${FS_LOG_DIR:-/tmp/fs-integration-$(date -u +%Y%m%dT%H%M%S)-$$}}
for arg in "$@"; do
  case "$arg" in
    --build) build=true ;;
    --*) printf '未知参数 %s\n' "$arg" >&2; exit 2 ;;
    *) log_dir=$arg ;;
  esac
done
mkdir -p "$log_dir"
chmod 0700 "$log_dir"
export FS_LOG_DIR=$(cd "$log_dir" && pwd)
umask 077
run_id=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
export FS_IMAGE=${FS_IMAGE:-fs-billing-freeswitch:local}
export WORKER_SHARED_KEY=${WORKER_SHARED_KEY:-$(python3 -c 'import secrets; print(secrets.token_hex(32))')}
[[ $WORKER_SHARED_KEY =~ ^[a-zA-Z0-9_-]{16,}$ ]] || { echo '共享密钥只接受至少 16 位字母、数字、下划线、横线' >&2; exit 2; }
export DATABASE_URL=${DATABASE_URL:-postgresql://fs_billing:local-development-only@127.0.0.1:5432/fs_billing}
export APP_DATABASE_URL=${APP_DATABASE_URL:-postgresql://fs_billing_app:local-app-only@127.0.0.1:5432/fs_billing}
export WORKER_HOST=127.0.0.1 WORKER_PORT=3001 WORKER_ALLOWED_IPS=127.0.0.1
export BILLING_WORKER_URL=http://127.0.0.1:3004
project=fsi-${run_id:0:12}
compose=(docker compose -p "$project" -f "$root/freeswitch/test/compose.yaml")
postgres=(docker compose -f "$root/compose.yaml")
worker_pid=
postgres_started=false
carrier_pid=
observer_name=$project-observer
authorize_script=$root/freeswitch/scripts/billing_authorize.lua
authorize_backup=
restore_authorize() {
  if [[ -n $authorize_backup ]]; then
    cp "$authorize_backup" "$authorize_script" || return 1
    authorize_backup=
  fi
}
current=准备
printf '用例\t结果\n' > "$FS_LOG_DIR/results.tsv"
stop_worker() {
  if [[ -n $worker_pid ]]; then
    kill "$worker_pid" 2>/dev/null || true
    for _ in $(seq 1 100); do
      kill -0 "$worker_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$worker_pid" 2>/dev/null || true
    wait "$worker_pid" 2>/dev/null || true
    worker_pid=
  fi
}
cleanup() {
  result=$?
  trap - EXIT
  set +e
  restore_authorize || result=1
  if (( result != 0 )); then printf '%s\tFAIL\n' "$current" >> "$FS_LOG_DIR/results.tsv"; fi
  "${compose[@]}" logs --no-color > "$FS_LOG_DIR/containers.log" 2>&1
  stop_worker
  docker rm -f "$observer_name" "$project-carrier" >/dev/null 2>&1
  "${compose[@]}" down --remove-orphans >/dev/null 2>&1
  local containers
  mapfile -t containers < <(docker ps -aq --filter "label=com.docker.compose.project=$project")
  if (( ${#containers[@]} )); then docker rm -f "${containers[@]}" >/dev/null 2>&1; fi
  if $postgres_started; then "${postgres[@]}" stop postgres >/dev/null 2>&1; fi
  if [[ -n $carrier_pid ]]; then wait "$carrier_pid" 2>/dev/null; fi
  if [[ -d $FS_LOG_DIR/cdr ]]; then
    docker run --rm --network none --entrypoint chown \
      -v "$FS_LOG_DIR/cdr:/cdr" "$FS_IMAGE" -R "$(id -u):$(id -g)" /cdr
  fi
  python3 - "$FS_LOG_DIR" <<'PY'
import os, pathlib, sys
key = os.environ['WORKER_SHARED_KEY'].encode()
for path in pathlib.Path(sys.argv[1]).rglob('*'):
    if path.is_file():
        body = path.read_bytes()
        if key in body:
            path.write_bytes(body.replace(key, b'[REDACTED]'))
PY
  cat "$FS_LOG_DIR/results.tsv"
  printf '日志 %s\n' "$FS_LOG_DIR"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pass() { printf '%s\tPASS\n' "$current" >> "$FS_LOG_DIR/results.tsv"; }
fail() { printf '%s\n' "$*" >&2; return 1; }
q() {
  "${postgres[@]}" exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -qAt -v ON_ERROR_STOP=1' <<< "$1"
}
wait_sql() {
  local statement=$1
  for _ in $(seq 1 150); do
    [[ $(q "$statement") == t ]] && return 0
    sleep 0.2
  done
  q "SELECT payload FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';" > "$FS_LOG_DIR/$case_name.raw.json"
  fail "数据库断言超时 $statement"
}
relay_ready() {
  for _ in $(seq 1 100); do
    if curl --noproxy '*' --silent --max-time 1 -o /dev/null http://127.0.0.1:3002/; then return 0; fi
    sleep 0.1
  done
  fail 'CDR relay 未就绪'
}
cli() { "${compose[@]}" exec -T freeswitch fs_cli -x "$1"; }
start_worker() {
  (cd "$root/apps/worker" && exec node --import tsx --env-file-if-exists=../../.env src/main.ts) >> "$FS_LOG_DIR/worker.log" 2>&1 &
  worker_pid=$!
  for _ in $(seq 1 100); do
    kill -0 "$worker_pid" 2>/dev/null || { fail 'Worker 启动失败'; return 1; }
    if curl --noproxy '*' --silent --max-time 1 -o /dev/null http://127.0.0.1:3001/authorize; then return 0; fi
    sleep 0.2
  done
  fail 'Worker 未就绪'
}
# 不接管已有监听者；退出时只停止本次启动的 Postgres。
python3 - <<'PY'
import socket
for port, kind in [(3001,socket.SOCK_STREAM),(3002,socket.SOCK_STREAM),(3003,socket.SOCK_STREAM),(3004,socket.SOCK_STREAM),(8021,socket.SOCK_STREAM),(5060,socket.SOCK_DGRAM),(5090,socket.SOCK_DGRAM)]:
    with socket.socket(socket.AF_INET,kind) as probe:
        if kind == socket.SOCK_STREAM:
            probe.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
        try:
            probe.bind(('127.0.0.1',port))
        except OSError as error:
            protocol = 'TCP' if kind == socket.SOCK_STREAM else 'UDP'
            raise SystemExit(f'{protocol} port {port} unavailable: {error}')
PY
if $build; then
  : "${SIGNALWIRE_TOKEN:?--build 需要 SIGNALWIRE_TOKEN 环境变量}"
  export SIGNALWIRE_TOKEN
  docker build --secret id=signalwire_token,env=SIGNALWIRE_TOKEN -f freeswitch/docker/Dockerfile -t "$FS_IMAGE" . > "$FS_LOG_DIR/build.log" 2>&1
fi
if [[ -z $("${postgres[@]}" ps --status running -q postgres) ]]; then postgres_started=true; fi
"${postgres[@]}" up -d --wait postgres > "$FS_LOG_DIR/postgres-start.log" 2>&1
pnpm db:migrate > "$FS_LOG_DIR/migrate.log" 2>&1
pnpm --filter @fs-billing/worker queue:migrate > "$FS_LOG_DIR/queue-migrate.log" 2>&1
"${postgres[@]}" exec -T postgres sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -v ON_ERROR_STOP=1 -v run_id="$1"' sh "$run_id" < freeswitch/test/seed.sql > "$FS_LOG_DIR/seed.log"
start_worker
"${compose[@]}" build sipp > "$FS_LOG_DIR/sipp-build.log" 2>&1
# 观测器只记录 SIP INVITE 和授权的非敏感字段，原始 HTTP header 不落盘。
docker run -d --name "$observer_name" --network host --cap-add NET_RAW \
  -v "$root/freeswitch/test/observe.py:/observe.py:ro" -v "$FS_LOG_DIR:/logs" \
  python:3.13.7-slim-bookworm python /observe.py > "$FS_LOG_DIR/observer-start.log"
for _ in $(seq 1 100); do
  curl --noproxy '*' --fail --silent --max-time 1 http://127.0.0.1:3004/health >/dev/null && break
  sleep 0.1
done
curl --noproxy '*' --fail --silent --max-time 1 http://127.0.0.1:3004/health >/dev/null
"${compose[@]}" up -d freeswitch nginx stall > "$FS_LOG_DIR/services-start.log" 2>&1
for _ in $(seq 1 150); do
  if cli 'status' 2>/dev/null | grep -Eq 'UP'; then break; fi
  sleep 0.2
done
cli 'status' | grep -Eq 'UP'
relay_ready
for _ in $(seq 1 100); do
  cli 'sofia status' > "$FS_LOG_DIR/sofia.log"
  grep -Eq 'customer[[:space:]]+profile[[:space:]]+.*RUNNING' "$FS_LOG_DIR/sofia.log" && break
  sleep 0.1
done
grep -Eq 'customer[[:space:]]+profile[[:space:]]+.*RUNNING' "$FS_LOG_DIR/sofia.log"
for module in mod_lua mod_sofia mod_json_cdr mod_dptools mod_dialplan_xml; do
  cli "module_exists $module" | grep -Eq true
done
cli 'lua /opt/fs-integration/fs_check.lua' > "$FS_LOG_DIR/fs-check.log"
grep -Eq 'PASS FS_CHECK' "$FS_LOG_DIR/fs-check.log"
"${compose[@]}" run --rm --name "$project-carrier" sipp -sf /scenarios/carrier.xml \
  -i 127.0.0.1 -p 5090 -mi 127.0.0.1 -mp 6002 -nostdin -trace_msg -message_file /logs/carrier.messages.log \
  -trace_err -error_file /logs/carrier.errors.log > "$FS_LOG_DIR/carrier.log" 2>&1 &
carrier_pid=$!
carrier_ready=false
for _ in $(seq 1 100); do
  if python3 - <<'PY'
import socket, sys
with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
    try: s.bind(('127.0.0.1',5090))
    except OSError: sys.exit(0)
sys.exit(1)
PY
  then carrier_ready=true; break; fi
  kill -0 "$carrier_pid" 2>/dev/null || fail 'Carrier 启动失败'
  sleep 0.1
done
$carrier_ready || fail 'Carrier 端口未就绪'
pass

carrier_invites() {
  python3 - "$FS_LOG_DIR/carrier.messages.log" <<'PYCOUNT'
from pathlib import Path
import sys
path=Path(sys.argv[1])
print(sum(line.startswith('INVITE ') for line in path.read_text().splitlines()) if path.exists() else 0)
PYCOUNT
}
call() {
  case_name=$1
  local ip=$2 destination=$3 scenario=${4:-caller.xml}
  dialed_number=$destination
  cid=$case_name-$run_id@fsi
  kill -0 "$carrier_pid" 2>/dev/null || fail 'Carrier 已退出'
  invites_before=$(carrier_invites)
  "${compose[@]}" run --rm sipp 127.0.0.1:5060 -sf "$scenario" -i "$ip" -p 5062 -mi "$ip" -mp 6000 \
    -s "$destination" -cid_str "$cid" -m 1 -l 1 -nostdin -timeout 85s -timeout_error \
    -trace_msg -message_file "/logs/$case_name.messages.log" \
    -trace_err -error_file "/logs/$case_name.errors.log" > "$FS_LOG_DIR/$case_name.sipp.log" 2>&1
}
uuids=""
identify() { uuids="SELECT payload->'variables'->>'uuid' FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid'"; }
charged() {
  identify
  wait_sql "SELECT (SELECT count(*) FROM cdrs WHERE call_uuid::text IN ($uuids))=1 AND (SELECT count(*) FROM ledger_entries WHERE kind='call_charge' AND idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid'))=1;"
  q "SELECT row_to_json(c) FROM cdrs c WHERE call_uuid::text IN ($uuids);" > "$FS_LOG_DIR/$case_name.cdr.json"
  q "SELECT payload FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';" > "$FS_LOG_DIR/$case_name.raw.json"
  q "SELECT row_to_json(l) FROM ledger_entries l WHERE kind='call_charge' AND idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid');" > "$FS_LOG_DIR/$case_name.ledger.json"
}
# AF_PACKET 用同一单调时钟记录 A-leg 和 carrier INVITE，排除启动容器的时间。
sip_assert() {
  local invites_after
  invites_after=$(carrier_invites)
  if [[ $1 == none ]]; then
    [[ $invites_after == "$invites_before" ]] || fail '拒绝呼叫仍出现在 carrier INVITE 日志'
  else
    (( invites_after > invites_before )) || fail 'carrier INVITE 日志缺失'
  fi
  python3 - "$FS_LOG_DIR/events.jsonl" "$cid" "$1" "$dialed_number" "${2:-}" "${3:-FSIOK}" <<'PY'
import json, sys
rows=[json.loads(line) for line in open(sys.argv[1])]
start=next(r['at'] for r in rows if r['kind']=='invite' and r['port']==5060 and r['call_id']==sys.argv[2])
out=[r for r in rows if r['kind']=='invite' and r['port']==5090 and r['at']>=start]
mode=sys.argv[3]
auth=[r for r in rows if r['kind']=='authorize' and r['at']>=start]
if sys.argv[5]:
    assert len(auth)==1,auth
    assert auth[0]['callee']==auth[0]['billingNumber']==sys.argv[5],auth
    assert auth[0]['dialedNumber']==sys.argv[4] and auth[0]['tenant']==sys.argv[6],auth
else:
    assert len(auth)==0,auth
if mode=='none':
    assert len(out)==0,out
else:
    assert len(out)==1,out
    assert out[0]['request']==f'INVITE sip:{sys.argv[4]}@127.0.0.1:5090 SIP/2.0',out
    if mode=='stalled':
        elapsed=out[0]['at']-start
        print('stalled INVITE seconds',elapsed)
        assert 1.3 <= elapsed <= 2.5,elapsed
PY
}
for normalization in \
  'plus +447700900123 447700900123 44 0.01' \
  'doublezero 00447700900123 447700900123 44 0.01' \
  'domestic-mobile 13800138000 8613800138000 8613 0.02' \
  'domestic-landline 07551234567 867551234567 86755 0.04' \
  'nanp-international +13055551234 13055551234 1 0.03' \
  'nanp-domestic 13055551234 8613055551234 861305 0.05'; do
  read -r label number billing_number matched_prefix rate <<< "$normalization"
  current="归一化 $label"
  call "$label" 127.0.0.2 "$number" /scenarios/caller.xml
  charged
  sip_assert normalized "$billing_number" >> "$FS_LOG_DIR/assertions.log"
  wait_sql "SELECT count(*)=1 AND bool_and(callee='$number' AND billing_number='$billing_number' AND matched_prefix='$matched_prefix' AND rate=$rate AND duration_seconds BETWEEN 1 AND 60 AND billed_minutes=1 AND charge=$rate) FROM cdrs WHERE call_uuid::text IN ($uuids);"
  wait_sql "SELECT count(*)>=1 AND bool_and(payload->'variables'->>'billing_dialed_number'='$number' AND payload->'variables'->>'billing_number'='$billing_number') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';"
  wait_sql "SELECT count(*)=1 AND bool_and(amount=-$rate AND note='通话扣费 ' || substring(idempotency_key FROM 6) || ' $billing_number') FROM ledger_entries WHERE kind='call_charge' AND idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid');"
  pass
done
for rejection in 'bad 127.0.0.2 bad 484' 'disabled 127.0.0.3 +447700900123 403 447700900123 FSIOFF' 'low 127.0.0.4 +447700900123 402 447700900123 FSILOW'; do
  read -r label ip number status billing_number tenant <<< "$rejection"
  current="拒绝 $status"
  sed "s/response=\"484\"/response=\"$status\"/" freeswitch/test/sipp/caller-reject.xml > "$FS_LOG_DIR/$label.xml"
  call "$label" "$ip" "$number" "/logs/$label.xml"
  sip_assert none "$billing_number" "$tenant" >> "$FS_LOG_DIR/assertions.log"
  identify
  wait_sql "SELECT count(*)>=1 FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';"
  if [[ $label == bad ]]; then
    wait_sql "SELECT EXISTS (SELECT 1 FROM unassigned_cdrs WHERE call_uuid::text IN ($uuids) AND reason='号码格式错误' AND call_uuid IS NOT NULL AND billing_number IS NULL);"
  else
    wait_sql "SELECT count(*)=1 AND bool_and(answered_at IS NULL AND duration_seconds=0 AND charge=0) FROM cdrs WHERE call_uuid::text IN ($uuids);"
    wait_sql "SELECT count(*)>=1 AND bool_and(state='completed') FROM pgboss.job WHERE name='charge-cdr' AND data->>'callUuid' IN ($uuids);"
  fi
  wait_sql "SELECT NOT EXISTS (SELECT 1 FROM ledger_entries WHERE kind='call_charge' AND idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid'));"
  pass
done
current='计费号码不一致 HTTP 400 / SIP 503'
authorize_backup=$FS_LOG_DIR/billing_authorize.original.lua
cp "$authorize_script" "$authorize_backup"
sed "s/destination:gsub('^0', '')/destination/" "$authorize_backup" > "$FS_LOG_DIR/billing_authorize.drift.lua"
if cmp -s "$authorize_backup" "$FS_LOG_DIR/billing_authorize.drift.lua"; then
  fail '号码漂移注入未改变 Lua 脚本'
fi
cp "$FS_LOG_DIR/billing_authorize.drift.lua" "$authorize_script"
sed 's/response="484"/response="503"/' freeswitch/test/sipp/caller-reject.xml > "$FS_LOG_DIR/mismatch.xml"
call mismatch 127.0.0.2 07551234567 /logs/mismatch.xml
sip_assert none 8607551234567 >> "$FS_LOG_DIR/assertions.log"
identify
wait_sql "SELECT count(*)>=1 AND bool_and(payload->'variables'->>'billing_dialed_number'='07551234567' AND payload->'variables'->>'billing_number'='8607551234567' AND payload->'variables'->>'hangup_cause'='NORMAL_TEMPORARY_FAILURE' AND (payload->'variables'->>'billing_unverified') IS DISTINCT FROM 'true') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';"
wait_sql "SELECT count(*)=1 AND bool_and(reason='计费号码不一致' AND billing_number='867551234567' AND call_uuid IS NOT NULL AND answered_at IS NULL AND duration_seconds=0) FROM unassigned_cdrs WHERE call_uuid::text IN ($uuids);"
# 告警按原因合并（阶段 9）：一条未恢复的 unassigned:计费号码不一致，描述含最近一通话的 UUID。
wait_sql "SELECT count(*)=1 FROM system_alerts a WHERE kind='cdr_failed' AND subject_key='unassigned:计费号码不一致' AND recovered_at IS NULL AND EXISTS (SELECT 1 FROM raw_cdrs r WHERE r.payload->'variables'->>'sip_call_id'='$cid' AND position(r.payload->'variables'->>'uuid' IN a.description) > 0);"
wait_sql "SELECT NOT EXISTS (SELECT 1 FROM cdrs WHERE call_uuid::text IN ($uuids)) AND NOT EXISTS (SELECT 1 FROM pgboss.job WHERE name='charge-cdr' AND data->>'callUuid' IN ($uuids)) AND NOT EXISTS (SELECT 1 FROM ledger_entries WHERE idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid')) AND NOT EXISTS (SELECT 1 FROM system_alerts a WHERE kind='auth_timeout' AND EXISTS (SELECT 1 FROM raw_cdrs r WHERE r.payload->'variables'->>'sip_call_id'='$cid' AND position(r.payload->'variables'->>'uuid' IN a.description) > 0));"
python3 - "$FS_LOG_DIR/worker.log" "$(q "$uuids")" <<'PY'
import json, pathlib, sys
uuids = set(sys.argv[2].splitlines())
logs = []
for line in pathlib.Path(sys.argv[1]).read_text().splitlines():
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(entry, dict):
        logs.append(entry)
mismatches = [entry for entry in logs if entry.get('msg') == '授权计费号码不一致' and entry.get('uuid') in uuids]
assert len(mismatches) == 1, f'Expected one billing mismatch log for {uuids}, got {len(mismatches)}'
req_id = mismatches[0].get('reqId')
assert req_id, 'Billing mismatch log has no reqId'
responses = [entry for entry in logs if entry.get('reqId') == req_id and isinstance(entry.get('res'), dict)]
assert len(responses) == 1, f'Expected one authorize response for {req_id}, got {len(responses)}'
assert responses[0]['res'].get('statusCode') == 400, f'Expected authorize HTTP 400 for {req_id}, got {responses[0]["res"]}'
PY
q "SELECT payload FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';" > "$FS_LOG_DIR/$case_name.raw.json"
q "SELECT row_to_json(u) FROM unassigned_cdrs u WHERE call_uuid::text IN ($uuids);" > "$FS_LOG_DIR/$case_name.unassigned.json"
q "SELECT row_to_json(a) FROM system_alerts a WHERE EXISTS (SELECT 1 FROM raw_cdrs r WHERE r.payload->'variables'->>'sip_call_id'='$cid' AND position(r.payload->'variables'->>'uuid' IN a.description) > 0);" > "$FS_LOG_DIR/$case_name.alerts.json"
restore_authorize
if command -v git >/dev/null 2>&1; then
  git diff --quiet -- freeswitch/scripts/billing_authorize.lua || fail '号码漂移测试后 Lua 脚本仍有改动'
fi
pass

current=ALLOTTED_TIMEOUT
call allotted 127.0.0.5 +447700900123 /scenarios/caller-timed.xml
charged
sip_assert outbound 447700900123 FSI60 >> "$FS_LOG_DIR/assertions.log"
# FSI60 余额 0.01、透支 0、费率 0.01/分钟，授权 maxSeconds=60。FreeSWITCH 调度器按整秒触发，
# sched_hangup +60 在接通后 59–60 秒挂断：时长允许误差为 59–60 秒。61 秒起按 60/60 计成 2 分钟，必须失败。
wait_sql "SELECT count(*)=1 AND bool_and(hangup_cause='ALLOTTED_TIMEOUT' AND duration_seconds BETWEEN 59 AND 60 AND billed_minutes=1 AND rate=0.01 AND charge=0.01) FROM cdrs WHERE call_uuid::text IN ($uuids);"
wait_sql "SELECT bool_or(payload->'variables'->>'execute_on_answer'='sched_hangup +60 ALLOTTED_TIMEOUT') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';"
# 扣费流水记为 -0.01；余额从 0.01 扣到 0，且等于该租户流水合计。
wait_sql "SELECT count(*)=1 AND bool_and(amount=-0.01) FROM ledger_entries WHERE kind='call_charge' AND idempotency_key IN (SELECT 'call:' || (payload->'variables'->>'uuid') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid');"
wait_sql "SELECT b.balance=0 AND b.balance=(SELECT sum(amount) FROM ledger_entries l WHERE l.tenant_id=t.id) FROM tenants t JOIN tenant_balances b ON b.tenant_id=t.id WHERE t.code='FSI60';"
pass

for outage in refused stalled; do
  current="授权降级 $outage"
  if [[ $outage == refused ]]; then
    stop_worker
    cli 'global_setvar billing_worker_url=http://127.0.0.1:3001' >/dev/null
  else
    cli 'global_setvar billing_worker_url=http://127.0.0.1:3003' >/dev/null
  fi
  call "$outage" 127.0.0.2 +447700900123 /scenarios/caller.xml
  sip_assert "$outage" >> "$FS_LOG_DIR/assertions.log"
  if [[ $outage == refused ]]; then start_worker; fi
  cli 'global_setvar billing_worker_url=http://127.0.0.1:3004' >/dev/null
  # 连接拒绝的通话在 hangup 时也无 Worker，完整失败话单按生产脚本重推。
  if [[ $outage == refused ]]; then
    sleep 4
    "${compose[@]}" exec -T freeswitch sh -c 'find /var/lib/freeswitch/cdr/retry -name "*.cdr.json" -exec touch -d "3 minutes ago" {} +'
    "${compose[@]}" exec -T freeswitch sh /usr/share/freeswitch/scripts/replay-cdr.sh > "$FS_LOG_DIR/refused-replay.log"
  fi
  charged
  wait_sql "SELECT bool_or(payload->'variables'->>'billing_unverified'='true' AND payload->'variables'->>'execute_on_answer'='sched_hangup +1800 ALLOTTED_TIMEOUT') FROM raw_cdrs WHERE payload->'variables'->>'sip_call_id'='$cid';"
  pass
done

current=话单重试与去重
case_name=replay
cid=replay-$run_id@fsi
# 停 relay 只阻断 CDR；授权仍走 Worker，通话接通后挂断触发落盘。
"${compose[@]}" stop nginx >/dev/null
call replay 127.0.0.2 +447700900123 /scenarios/caller.xml
sip_assert outbound 447700900123 >> "$FS_LOG_DIR/assertions.log"
retry_file=
for _ in $(seq 1 100); do
  retry_file=$("${compose[@]}" exec -T freeswitch sh -c 'for f in /var/lib/freeswitch/cdr/retry/*.cdr.json; do [ -f "$f" ] || continue; grep -Fq "$1" "$f" && { printf "%s" "$f"; break; }; done; true' sh "$cid")
  [[ -n $retry_file ]] && break
  sleep 0.2
done
[[ -n $retry_file ]] || fail 'mod_json_cdr 未写入 retry'
"${compose[@]}" exec -T freeswitch cat "$retry_file" > "$FS_LOG_DIR/replay.retry.json"
identify
retry_uuid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["variables"]["uuid"])' "$FS_LOG_DIR/replay.retry.json")
[[ $retry_uuid =~ ^[a-fA-F0-9-]{36}$ ]] || fail 'retry UUID 非法'
[[ $(q "SELECT count(*) FROM cdrs WHERE call_uuid='$retry_uuid';") == 0 ]] || fail '重推前已有正式话单'
"${compose[@]}" start nginx >/dev/null
relay_ready
"${compose[@]}" exec -T freeswitch touch -d '3 minutes ago' "$retry_file"
"${compose[@]}" exec -T freeswitch sh /usr/share/freeswitch/scripts/replay-cdr.sh > "$FS_LOG_DIR/replay.log"
"${compose[@]}" exec -T freeswitch test ! -f "$retry_file"
charged
archive_file=${retry_file/\/retry\//\/archive\/}
"${compose[@]}" exec -T freeswitch cat "$archive_file" > "$FS_LOG_DIR/replay.archive.json"
curl --noproxy '*' --fail --silent --show-error --max-time 10 -H 'Content-Type: application/json' \
  --data-binary "@$FS_LOG_DIR/replay.archive.json" http://127.0.0.1:3002/cdr > "$FS_LOG_DIR/replay.duplicate.json"
python3 - "$FS_LOG_DIR/replay.duplicate.json" <<'PY'
import json,sys
assert json.load(open(sys.argv[1]))['status']=='duplicate'
PY
charged
pass
