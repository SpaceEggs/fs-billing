#!/usr/bin/env bash
# Self-test for verify_redact in lib.sh. Needs no running stack. Exit 0 when every case
# redacts as expected, 1 otherwise. Prints case names and diffs, never a real secret
# (all values below are synthetic).
# Usage: selftest-redact.sh
source "$(dirname "$0")/lib.sh"

export SEED_AUTH_PASSWORD='seed-Pw.1' BETTER_AUTH_SECRET='auth-secret-xyz'
export PG_OWNER_PASSWORD='' PG_APP_PASSWORD='' PG_AUTH_PASSWORD=''

failures=0
# check <name> <input> <expected output> [leaked value that must not survive]...
check() {
  local name=$1 input=$2 expected=$3 actual leak
  shift 3
  actual=$(printf '%s' "$input" | verify_redact)
  for leak in "$@"; do
    if [[ $actual == *"$leak"* ]]; then
      echo "FAIL $name: synthetic value '$leak' survived"
      failures=$((failures + 1))
      return
    fi
  done
  if [[ $actual != "$expected" ]]; then
    echo "FAIL $name"
    diff <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") | sed 's/^/  /'
    failures=$((failures + 1))
    return
  fi
  echo "ok   $name"
}

check 'single-line field' \
  '{"email":"a@example.com","newPassword":"hunter2-x"}' \
  '{"email":"a@example.com","newPassword":"[REDACTED]"}' \
  hunter2-x

check 'value on the next line' \
  $'{\n  "newPassword":\n    "split-value-1"\n}' \
  $'{\n  "newPassword":\n    "[REDACTED]"\n}' \
  split-value-1

check 'colon on its own line' \
  $'{"temporaryPassword"\n:\n"split-value-2"}' \
  $'{"temporaryPassword"\n:\n"[REDACTED]"}' \
  split-value-2

check 'pretty-printed, several fields' \
  $'{\n  "currentPassword": "old-pw-3",\n  "newPassword": "new-pw-3",\n  "email": "keep@example.com"\n}' \
  $'{\n  "currentPassword": "[REDACTED]",\n  "newPassword": "[REDACTED]",\n  "email": "keep@example.com"\n}' \
  old-pw-3 new-pw-3

check 'escaped quotes in the value' \
  '{"password":"a\"b\\\"c-tail","next":"kept"}' \
  '{"password":"[REDACTED]","next":"kept"}' \
  'c-tail'

check 'escaped quotes, multi-line' \
  $'{\n  "token":\n  "x\\"y\\\\\\"z-tail"\n}' \
  $'{\n  "token":\n  "[REDACTED]"\n}' \
  'z-tail'

check 'session cookie' \
  $'set-cookie: better-auth.session_token=abc.def%2F; Path=/\nnext line' \
  $'set-cookie: better-auth.session_token=[REDACTED]; Path=/\nnext line' \
  abc.def

check 'run.env secrets anywhere' \
  $'seed-Pw.1 and\nauth-secret-xyz' \
  $'[REDACTED] and\n[REDACTED]' \
  seed-Pw.1 auth-secret-xyz

check 'non-sensitive fields unchanged' \
  $'{\n  "email": "a@example.com",\n  "passwordChangedAt": "2026-10-14"\n}' \
  $'{\n  "email": "a@example.com",\n  "passwordChangedAt": "2026-10-14"\n}'

if (( failures )); then
  echo "selftest-redact: $failures failure(s)" >&2
  exit 1
fi
echo 'selftest-redact: all cases pass'
