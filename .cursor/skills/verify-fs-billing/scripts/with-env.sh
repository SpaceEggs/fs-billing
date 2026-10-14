#!/usr/bin/env bash
# Run a repo command with this run's environment (our DB URLs, auth secret, seed password).
# Exported values win over the root .env, which every pnpm script loads with
# --env-file-if-exists, so documented commands hit our container, not :5432.
# Usage: with-env.sh <command...>     e.g. with-env.sh pnpm --filter @fs-billing/api auth:unlock hzx014@example.com
# Output is redacted; secrets never reach the terminal.
source "$(dirname "$0")/lib.sh"
verify_load
[[ $# -gt 0 ]] || die 'usage: with-env.sh <command...>'
cd "$VERIFY_REPO"
set +e
"$@" 2>&1 | verify_redact | sed -E 's#(postgres(ql)?://[^:/@]+:)[^@]+@#\1[REDACTED]@#g'
exit "${PIPESTATUS[0]}"
