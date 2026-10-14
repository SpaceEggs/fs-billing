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

VERIFY_SECRET_KEYS=(BETTER_AUTH_SECRET SEED_AUTH_PASSWORD PG_OWNER_PASSWORD PG_APP_PASSWORD PG_AUTH_PASSWORD)
# JSON fields that carry a credential, including ones the run never knew (a reset's
# temporaryPassword). Keep in sync with sensitiveJsonFields in drive.mjs.
VERIFY_SENSITIVE_JSON='password|currentPassword|newPassword|temporaryPassword|token|secret'

# Replace every secret value from run.env with [REDACTED], plus cookie values and
# sensitive JSON fields. sed -z reads the whole input as one record, so a field whose
# key, colon, and value sit on separate lines (pretty-printed JSON) is still caught.
# Self-test: scripts/selftest-redact.sh.
verify_redact() {
  local args=() key value
  for key in "${VERIFY_SECRET_KEYS[@]}"; do
    value=${!key:-}
    [[ -n $value ]] && args+=(-e "s|${value}|[REDACTED]|g")
  done
  args+=(-e 's/(session_token=)[^;[:space:]"]+/\1[REDACTED]/g')
  args+=(-e "s/(\"(${VERIFY_SENSITIVE_JSON})\"[[:space:]]*:[[:space:]]*\")([^\"\\\\]|\\\\.)*\"/\\1[REDACTED]\"/g")
  sed -zE "${args[@]}"
}

# Evidence files that contain any run.env secret. Prints file names only, never the match.
verify_leak_scan() {
  local key value found=0
  for key in "${VERIFY_SECRET_KEYS[@]}"; do
    value=${!key:-}
    [[ -n $value ]] || continue
    grep -rlF -e "$value" -- "$1" && found=1
  done
  return $(( found ))
}

# The API allows 30 credential requests (login, change-password) per minute per IP in a
# fixed window. Record each one so the next journey can wait out the window.
verify_note_credential_request() {
  date +%s > "$STATE/credential-at"
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
