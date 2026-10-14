#!/usr/bin/env bash
# Tear down one run: kill only the process groups it recorded, remove only its labelled
# container, copy redacted logs into evidence, delete scratch state. Evidence is kept.
# Usage: cleanup.sh            (VERIFY_RUN_ID=<id> cleanup.sh for a specific run)
source "$(dirname "$0")/lib.sh"
verify_load
set +e

for name in web api; do
  pid=$(cat "$STATE/$name.pid" 2>/dev/null)
  [[ -n $pid ]] || continue
  if verify_owns_pid "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null
    echo "stopped $name (process group $pid)"
  else
    echo "$name pid $pid is gone or not from run $RUN_ID; not killing it"
  fi
done

id=$(cat "$STATE/container.id" 2>/dev/null)
if [[ -n $id && $VERIFY_CONTAINER != "$VERIFY_FORBIDDEN_CONTAINER" && \
      $(docker inspect -f '{{index .Config.Labels "fs-billing-verify"}}' "$id" 2>/dev/null) == "$RUN_ID" ]]; then
  docker rm -f "$id" >/dev/null && echo "removed container $VERIFY_CONTAINER (${id:0:12})"
else
  echo "no container labelled for run $RUN_ID; nothing removed"
fi

mkdir -p "$EVIDENCE/logs"
for log in "$STATE"/*.log; do
  [[ -f $log ]] && verify_redact < "$log" > "$EVIDENCE/logs/$(basename "$log")"
done
cp "$STATE/revision.txt" "$STATE/worktree.txt" "$EVIDENCE/logs/" 2>/dev/null

case $STATE in
  "$VERIFY_STATE_ROOT"/*) rm -rf -- "$STATE" ;;
esac
[[ $(cat "$VERIFY_STATE_ROOT/current" 2>/dev/null) == "$RUN_ID" ]] && rm -f "$VERIFY_STATE_ROOT/current"

if [[ -d $EVIDENCE ]]; then
  echo "evidence kept: $EVIDENCE ($(find "$EVIDENCE" -type f | wc -l | tr -d ' ') files)"
else
  echo "evidence missing at $EVIDENCE" >&2; exit 1
fi
