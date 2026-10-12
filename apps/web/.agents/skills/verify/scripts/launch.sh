#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || [[ "$1" != /* ]]; then
  echo 'Usage: launch.sh /absolute/path/to/new/evidence-directory' >&2
  exit 2
fi

verify_run="$1"
verify_repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$verify_repo"
mkdir -p "$verify_run"
if [ -e "$verify_run/launcher.pid" ]; then
  echo 'Use a new evidence directory for each launch.' >&2
  exit 1
fi

python3 - <<'PY'
import socket

sockets = []
for port in (3000, 3001, 5173):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', port))
    sockets.append(listener)
print('Required development ports are available.', flush=True)
PY

printf '%s\n' "$verify_repo" > "$verify_run/root.txt"
git rev-parse HEAD > "$verify_run/revision.txt"
git status --short > "$verify_run/worktree.txt"
printf '%s\n' "$$" > "$verify_run/launcher.pid"
export API_HOST=127.0.0.1 API_PORT=3000 WORKER_HOST=127.0.0.1 WORKER_PORT=3001
printf 'Launching pnpm dev. Evidence: %s\n' "$verify_run"
exec pnpm dev > "$verify_run/dev.log" 2>&1
