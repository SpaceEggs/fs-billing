# Sourced by the verify-fs-billing helpers. Not executable on its own.
# shellcheck shell=bash
set -euo pipefail

VERIFY_SKILL_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VERIFY_REPO=$(git -C "$VERIFY_SKILL_DIR" rev-parse --show-toplevel)
VERIFY_STATE_ROOT=${VERIFY_STATE_ROOT:-${TMPDIR:-/tmp}/verify-fs-billing}
VERIFY_EVIDENCE_ROOT=$VERIFY_REPO/docs/evidence/verify-fs-billing
# The user's own dev database. Never touched by this skill.
VERIFY_FORBIDDEN_CONTAINER=fs-billing-postgres-1

die() { printf 'verify-fs-billing: %s\n' "$*" >&2; exit 1; }

# Resolve the run: $VERIFY_RUN_ID, else the run launch.sh recorded last.
verify_run_id() {
  if [[ -n ${VERIFY_RUN_ID:-} ]]; then printf '%s\n' "$VERIFY_RUN_ID"; return; fi
  [[ -f $VERIFY_STATE_ROOT/current ]] || die "no run recorded; run launch.sh or set VERIFY_RUN_ID"
  cat "$VERIFY_STATE_ROOT/current"
}

# Load a run's state into the environment: RUN_ID, STATE, EVIDENCE, and run.env.
verify_load() {
  RUN_ID=$(verify_run_id)
  [[ $RUN_ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6}$ ]] || die "malformed run id: $RUN_ID"
  STATE=$VERIFY_STATE_ROOT/$RUN_ID
  EVIDENCE=$VERIFY_EVIDENCE_ROOT/$RUN_ID
  [[ -f $STATE/run.env ]] || die "no state for run $RUN_ID at $STATE"
  set -a
  # shellcheck disable=SC1091
  source "$STATE/run.env"
  set +a
  export RUN_ID STATE EVIDENCE
}

# Replace every secret value from run.env with [REDACTED], plus cookie values.
verify_redact() {
  local args=() key value
  for key in BETTER_AUTH_SECRET SEED_AUTH_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD PG_AUTH_PASSWORD; do
    value=${!key:-}
    [[ -n $value ]] && args+=(-e "s|${value}|[REDACTED]|g")
  done
  args+=(-e 's/(session_token=)[^;[:space:]"]+/\1[REDACTED]/g')
  sed -E "${args[@]}"
}

verify_free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()'
}

# True when pid is alive and carries this run's VERIFY_RUN_ID in its environment.
verify_owns_pid() {
  local pid=$1
  [[ -r /proc/$pid/environ ]] || return 1
  tr '\0' '\n' < "/proc/$pid/environ" | grep -qx "VERIFY_RUN_ID=$RUN_ID"
}

# PIDs listening on 127.0.0.1:<port>.
verify_port_pids() {
  ss -Hltnp "sport = :$1" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u
}
