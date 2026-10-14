#!/usr/bin/env bash
# Run SQL as the owner role inside THIS run's Postgres container (never the user's).
# Usage: sql.sh "SELECT ..."      or      sql.sh < file.sql
#        sql.sh --value "SELECT ..."   unaligned, tuples only (one value per line)
source "$(dirname "$0")/lib.sh"
verify_load

[[ $VERIFY_CONTAINER != "$VERIFY_FORBIDDEN_CONTAINER" ]] || die 'refusing to touch the user container'
[[ $(docker inspect -f '{{index .Config.Labels "fs-billing-verify"}}' "$VERIFY_CONTAINER" 2>/dev/null) == "$RUN_ID" ]] \
  || die "container $VERIFY_CONTAINER is not labelled for run $RUN_ID"

psql=(docker exec -i "$VERIFY_CONTAINER" psql -U fs_billing -d fs_billing -X -v ON_ERROR_STOP=1 -P pager=off)
if [[ ${1:-} == --value ]]; then psql+=(-Atq); shift; fi
if [[ $# -gt 0 ]]; then
  "${psql[@]}" -c "$*"
else
  "${psql[@]}"
fi
