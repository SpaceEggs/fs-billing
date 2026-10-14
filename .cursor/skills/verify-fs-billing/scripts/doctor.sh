#!/usr/bin/env bash
# Is this run's instance worth driving? Prints one OK/FAIL line per check; exit 1 on any FAIL.
# Usage: doctor.sh            (VERIFY_RUN_ID=<id> doctor.sh for a specific run)
# Read-only: no logins, no DB writes, no files. Launch's ready check is the login proof.
source "$(dirname "$0")/lib.sh"
verify_load
set +e

failures=0
ok() { printf 'OK    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; failures=$((failures + 1)); }
echo "run $RUN_ID"

# Container: ours by name, id, label, and port; never the user's.
id=$(cat "$STATE/container.id" 2>/dev/null)
read -r running label port < <(docker inspect -f '{{.State.Running}} {{index .Config.Labels "fs-billing-verify"}} {{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$id" 2>/dev/null)
container_ok=false
if [[ $running == true && $label == "$RUN_ID" && $port == "$VERIFY_PG_PORT" && $VERIFY_CONTAINER != "$VERIFY_FORBIDDEN_CONTAINER" ]]; then
  container_ok=true
  ok "postgres container $VERIFY_CONTAINER (${id:0:12}) running, labelled, 127.0.0.1:$port"
else
  bad "postgres container $VERIFY_CONTAINER running=$running label=$label port=$port"
fi

# Processes: alive, carry our VERIFY_RUN_ID, and own their listening port.
check_proc() {
  local name=$1 pidfile=$2 port=$3 pid listeners owned=false l
  pid=$(cat "$pidfile" 2>/dev/null)
  if [[ -z $pid ]] || ! verify_owns_pid "$pid"; then bad "$name pid ${pid:-?} not alive or not from run $RUN_ID"; return; fi
  listeners=$(verify_port_pids "$port")
  for l in $listeners; do
    [[ $(ps -o pgid= -p "$l" | tr -d ' ') == "$pid" ]] && verify_owns_pid "$l" && owned=true
  done
  if $owned; then ok "$name pid $pid alive, owns 127.0.0.1:$port"; else bad "$name port $port listeners [${listeners//$'\n'/ }] not in pgid $pid"; fi
}
check_proc api "$STATE/api.pid" "$VERIFY_API_PORT"
check_proc web "$STATE/web.pid" "$VERIFY_WEB_PORT"

# Revision: what was launched vs what is checked out now.
launched=$(cat "$STATE/revision.txt") head=$(git -C "$VERIFY_REPO" rev-parse HEAD)
dirty=$(git -C "$VERIFY_REPO" status --short | wc -l | tr -d ' ')
if [[ $launched == "$head" ]]; then ok "git $head ($dirty uncommitted paths)"; else bad "launched at $launched but HEAD is now $head; relaunch"; fi

# Database: reachable, every journal migration applied, seed and auth seed present.
# Only through sql.sh's guards, and only when the container check above passed.
expected=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["entries"]))' "$VERIFY_REPO/packages/db/migrations/meta/_journal.json")
if ! $container_ok; then
  bad 'db: not queried, the container is not ours'
else
  row=$("$(dirname "$0")/sql.sh" --value \
    "SELECT (SELECT count(*) FROM drizzle.__drizzle_migrations), (SELECT count(*) FROM tenants), (SELECT count(*) FROM auth.account WHERE provider_id='credential')" 2>&1)
  IFS='|' read -r applied tenants creds <<< "$row"
  if [[ $applied == "$expected" && $tenants -gt 0 && $creds -gt 0 ]]; then
    ok "db migrations $applied/$expected, tenants $tenants, credentials $creds"
  else
    bad "db: migrations ${applied:-?}/$expected tenants ${tenants:-?} credentials ${creds:-?} ($row)"
  fi
fi

# API and web.
health=$(curl -sf --max-time 5 "$VERIFY_API_ORIGIN/api/health")
[[ $health == '{"status":"ok","service":"api"}' ]] && ok "api health $health" || bad "api health: ${health:-no answer}"
html=$(curl -sf --max-time 5 "$VERIFY_WEB_ORIGIN/login")
[[ $html == *'<div id="root">'* && $html == *'/assets/'* ]] && ok "web serves built app at $VERIFY_WEB_ORIGIN" || bad 'web did not serve the built index.html'
proxied=$(curl -sf --max-time 5 "$VERIFY_WEB_ORIGIN/api/health")
[[ $proxied == "$health" && -n $health ]] && ok 'web proxies /api to our API' || bad "web /api proxy: ${proxied:-no answer}"

if (( failures )); then echo "doctor: $failures check(s) failed"; exit 1; fi
echo 'doctor: healthy'
