#!/usr/bin/env bash
# HTTP against this run's stack, through the web origin's /api proxy (the browser's path).
# Usage:
#   api.sh login <email> <jar> [--wrong]     POST /api/auth/login with the seeded password
#                                            (or a fixed wrong one); cookies go to jar <jar>
#   api.sh <METHOD> <PATH> [jar] [json-body] any other request, optionally with jar cookies
# Prints a redacted HTTP transcript (request line, response status, headers, body).
# Set VERIFY_API_BASE=api to hit the API origin directly instead of the web proxy.
source "$(dirname "$0")/lib.sh"
verify_load

base=$VERIFY_WEB_ORIGIN
[[ ${VERIFY_API_BASE:-web} == api ]] && base=$VERIFY_API_ORIGIN
mkdir -p "$STATE/jars"

body_file=
cleanup_body() { [[ -n $body_file ]] && rm -f "$body_file"; return 0; }
trap cleanup_body EXIT

if [[ ${1:-} == login ]]; then
  [[ $# -ge 3 ]] || die 'usage: api.sh login <email> <jar> [--wrong]'
  email=$2 jar=$3 method=POST path=/api/auth/login
  body_file=$(mktemp "$STATE/body.XXXXXX")
  VERIFY_EMAIL=$email VERIFY_WRONG=${4:-} python3 -c '
import json, os
pw = "wrong-password-verify" if os.environ["VERIFY_WRONG"] == "--wrong" else os.environ["SEED_AUTH_PASSWORD"]
print(json.dumps({"email": os.environ["VERIFY_EMAIL"], "password": pw}), end="")' > "$body_file"
  shown_body="{\"email\":\"$email\",\"password\":\"[REDACTED]\"}"
else
  [[ $# -ge 2 ]] || die 'usage: api.sh <METHOD> <PATH> [jar] [json-body]'
  method=$1 path=$2 jar=${3:-} shown_body=${4:-}
  if [[ -n ${4:-} ]]; then
    body_file=$(mktemp "$STATE/body.XXXXXX")
    printf '%s' "$4" > "$body_file"
  fi
fi

args=(-sS -i -X "$method" -H "Origin: $VERIFY_WEB_ORIGIN" --max-time 20)
[[ -n $jar ]] && args+=(-b "$STATE/jars/$jar.txt" -c "$STATE/jars/$jar.txt")
[[ -n $body_file ]] && args+=(-H 'Content-Type: application/json' --data-binary "@$body_file")

{
  printf '> %s %s%s\n' "$method" "$base" "$path"
  printf '> Origin: %s\n' "$VERIFY_WEB_ORIGIN"
  [[ -n $jar ]] && printf '> Cookie: (jar %s)\n' "$jar"
  [[ -n $shown_body ]] && printf '> Body: %s\n' "$shown_body"
  printf '\n'
  curl "${args[@]}" "$base$path"
  printf '\n'
} | tr -d '\r' | verify_redact
