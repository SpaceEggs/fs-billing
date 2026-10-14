#!/usr/bin/env bash
# Tear down one run: kill only the process groups it recorded, remove only its labelled
# container, copy redacted logs into evidence, delete scratch state. Evidence is kept.
# State (and its secrets) is deleted only when every step succeeded, so a failed cleanup
# can be rerun. Exit 1 on any failure.
# Usage: cleanup.sh            (VERIFY_RUN_ID=<id> cleanup.sh for a specific run)
source "$(dirname "$0")/lib.sh"
verify_load

failures=0
fail() { echo "cleanup: $*" >&2; failures=$((failures + 1)); }

for name in web api; do
  pid=$(cat "$STATE/$name.pid" 2>/dev/null || true)
  [[ -n $pid ]] || continue
  if verify_owns_pid "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -KILL -- "-$pid" 2>/dev/null || true
    sleep 0.2
    if verify_owns_pid "$pid"; then fail "$name process group $pid survived KILL"; else echo "stopped $name (process group $pid)"; fi
  else
    echo "$name pid $pid is gone or not from run $RUN_ID; not killing it"
  fi
done

# Print the container's run label. Return 1 only when Docker confirms the container does
# not exist; any other inspect failure (daemon down, permission denied) returns 2 with
# Docker's message, so the state is kept.
container_label() {
  local out
  if out=$(docker inspect -f '{{index .Config.Labels "fs-billing-verify"}}' "$1" 2>&1); then
    printf '%s' "$out"
  elif [[ $out == *'No such object'* ]]; then
    return 1
  else
    printf '%s' "$out"
    return 2
  fi
}

id=$(cat "$STATE/container.id" 2>/dev/null || true)
if [[ -z $id ]]; then
  echo 'no container id recorded; nothing removed'
elif [[ $VERIFY_CONTAINER == "$VERIFY_FORBIDDEN_CONTAINER" ]]; then
  fail "refusing to touch $VERIFY_FORBIDDEN_CONTAINER"
else
  found=0
  label=$(container_label "$id") || found=$?
  if (( found == 1 )); then
    echo "container ${id:0:12} is already gone"
  elif (( found == 2 )); then
    fail "cannot inspect container ${id:0:12}, so it may still exist: $label"
  elif [[ $label != "$RUN_ID" ]]; then
    fail "container ${id:0:12} is labelled '$label', not $RUN_ID; not removing it"
  else
    gone=0
    docker rm -f "$id" >/dev/null && { container_label "$id" >/dev/null || gone=$?; }
    if (( gone == 1 )); then
      echo "removed container $VERIFY_CONTAINER (${id:0:12})"
    else
      fail "could not remove container $VERIFY_CONTAINER (${id:0:12}), or cannot confirm it is gone"
    fi
  fi
fi

mkdir -p "$EVIDENCE/logs" || fail "cannot create $EVIDENCE/logs"
for log in "$STATE"/*.log; do
  [[ -f $log ]] || continue
  verify_redact < "$log" > "$EVIDENCE/logs/$(basename "$log" .log).log.txt" || fail "could not copy $log"
done
for file in revision.txt worktree.txt; do
  [[ -f $STATE/$file ]] && { cp "$STATE/$file" "$EVIDENCE/logs/" || fail "could not copy $file"; }
done

if ! leaks=$(verify_leak_scan "$EVIDENCE"); then
  fail "run secrets found in evidence files (names only): ${leaks//$'\n'/ }"
fi

if (( failures )); then
  echo "cleanup: $failures failure(s); state kept at $STATE so you can fix and rerun" >&2
  exit 1
fi

case $STATE in
  "$VERIFY_STATE_ROOT"/*) rm -rf -- "$STATE" ;;
esac
[[ $(cat "$VERIFY_STATE_ROOT/current" 2>/dev/null) == "$RUN_ID" ]] && rm -f "$VERIFY_STATE_ROOT/current"
echo "evidence kept: $EVIDENCE ($(find "$EVIDENCE" -type f | wc -l | tr -d ' ') files)"
