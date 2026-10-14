#!/usr/bin/env bash
# Start an isolated FS-Billing stack: dedicated Postgres container, API, web preview.
# Usage: launch.sh            (prints RUN_ID on the last line)
source "$(dirname "$0")/lib.sh"

command -v docker >/dev/null || die 'docker is required'
command -v ss >/dev/null || die 'ss (iproute2) is required for port ownership checks'
[[ -d $VERIFY_REPO/node_modules/.pnpm ]] || die 'run pnpm install --frozen-lockfile first'

RUN_ID=$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(3))')
STATE=$VERIFY_STATE_ROOT/$RUN_ID
EVIDENCE=$VERIFY_EVIDENCE_ROOT/$RUN_ID
umask 077
mkdir -p "$STATE" "$EVIDENCE/launch"
chmod 700 "$VERIFY_STATE_ROOT" "$STATE"
printf '%s\n' "$RUN_ID" > "$VERIFY_STATE_ROOT/current"
trap 'status=$?; (( status == 0 )) || echo "launch failed; logs in $STATE; tear down with: VERIFY_RUN_ID=$RUN_ID $(dirname "$0")/cleanup.sh" >&2' EXIT

container=fsb-verify-$RUN_ID
pg_port=$(verify_free_port)
api_port=$(verify_free_port)
web_port=$(verify_free_port)
while [[ $api_port == "$pg_port" ]]; do api_port=$(verify_free_port); done
while [[ $web_port == "$pg_port" || $web_port == "$api_port" ]]; do web_port=$(verify_free_port); done
secret() { python3 -c 'import secrets; print(secrets.token_hex(24))'; }
api_origin=http://127.0.0.1:$api_port
web_origin=http://127.0.0.1:$web_port

# Every database/auth/port variable the root .env defines is set here, so even a
# command that loads .env cannot fall through to the user's database on :5432.
pg_owner=$(secret) pg_app=$(secret) pg_auth=$(secret)
cat > "$STATE/run.env" <<EOF
VERIFY_RUN_ID=$RUN_ID
VERIFY_CONTAINER=$container
VERIFY_PG_PORT=$pg_port
VERIFY_API_PORT=$api_port
VERIFY_WEB_PORT=$web_port
VERIFY_API_ORIGIN=$api_origin
VERIFY_WEB_ORIGIN=$web_origin
PG_OWNER_PASSWORD=$pg_owner
PG_APP_PASSWORD=$pg_app
PG_AUTH_PASSWORD=$pg_auth
POSTGRES_DB=fs_billing
POSTGRES_USER=fs_billing
POSTGRES_PASSWORD=$pg_owner
POSTGRES_PORT=$pg_port
DATABASE_URL=postgresql://fs_billing:$pg_owner@127.0.0.1:$pg_port/fs_billing
APP_DATABASE_URL=postgresql://fs_billing_app:$pg_app@127.0.0.1:$pg_port/fs_billing
AUTH_DATABASE_URL=postgresql://fs_billing_auth:$pg_auth@127.0.0.1:$pg_port/fs_billing
API_HOST=127.0.0.1
API_PORT=$api_port
BETTER_AUTH_SECRET=$(secret)
BETTER_AUTH_URL=$api_origin
BETTER_AUTH_TRUSTED_ORIGINS=$api_origin,$web_origin
SEED_AUTH_PASSWORD=$(secret)
FS_BILLING_API_ORIGIN=$api_origin
NODE_ENV=development
EOF
chmod 600 "$STATE/run.env"
set -a; source "$STATE/run.env"; set +a
export RUN_ID STATE EVIDENCE
git -C "$VERIFY_REPO" rev-parse HEAD > "$STATE/revision.txt"
git -C "$VERIFY_REPO" status --short > "$STATE/worktree.txt"

echo "[1/6] Postgres container $container on 127.0.0.1:$pg_port"
docker run -d --name "$container" --label "fs-billing-verify=$RUN_ID" \
  -e POSTGRES_DB -e POSTGRES_USER -e POSTGRES_PASSWORD -e TZ=UTC -e PGTZ=UTC \
  -p "127.0.0.1:$pg_port:5432" --tmpfs /var/lib/postgresql/data \
  postgres:17.9-alpine > "$STATE/container.id"
# The image's init server listens on the socket only; TCP answers once init is done.
for _ in $(seq 1 120); do
  docker exec "$container" pg_isready -h 127.0.0.1 -U fs_billing -d fs_billing >/dev/null 2>&1 && break
  sleep 0.5
done
docker exec "$container" pg_isready -h 127.0.0.1 -U fs_billing -d fs_billing >/dev/null

# tsx is called directly (not the pnpm scripts) so the root .env is never loaded.
echo '[2/6] migrate + seed + migrate (idempotence) + auth:seed'
(
  cd "$VERIFY_REPO/packages/db"
  pnpm exec tsx src/bin/migrate.ts
  pnpm exec tsx src/bin/seed.ts
  pnpm exec tsx src/bin/migrate.ts
) > "$STATE/db-setup.log" 2>&1
(cd "$VERIFY_REPO/apps/api" && node --import tsx scripts/seed-auth.ts) > "$STATE/auth-seed.log" 2>&1

echo "[3/6] API on $api_origin"
(cd "$VERIFY_REPO/apps/api" && exec setsid node --import tsx src/main.ts) > "$STATE/api.log" 2>&1 &
echo $! > "$STATE/api.pid"
for _ in $(seq 1 120); do
  curl -sf "$api_origin/api/health" >/dev/null 2>&1 && break
  kill -0 "$(cat "$STATE/api.pid")" 2>/dev/null || die "API exited; see $STATE/api.log"
  sleep 0.5
done
curl -sf "$api_origin/api/health" >/dev/null

echo "[4/6] web build into $STATE/web-dist"
(cd "$VERIFY_REPO/apps/web" && pnpm exec vite build --outDir "$STATE/web-dist" --emptyOutDir) > "$STATE/web-build.log" 2>&1

echo "[5/6] web preview on $web_origin (proxies /api to $api_origin)"
(cd "$VERIFY_REPO/apps/web" && exec setsid node_modules/.bin/vite preview --host 127.0.0.1 --port "$web_port" --strictPort --outDir "$STATE/web-dist") > "$STATE/web.log" 2>&1 &
echo $! > "$STATE/web.pid"
for _ in $(seq 1 60); do
  curl -sf "$web_origin/" >/dev/null 2>&1 && break
  kill -0 "$(cat "$STATE/web.pid")" 2>/dev/null || die "web exited; see $STATE/web.log"
  sleep 0.5
done

echo '[6/6] ready check: real seeded login and logout through the web origin'
ready=$EVIDENCE/launch/ready-login.http
"$(dirname "$0")/api.sh" login bjh003@example.com ready > "$ready"
grep -q '^HTTP/1.1 200' "$ready" && grep -q '"kind":"customer"' "$ready" && grep -q '"email":"bjh003@example.com"' "$ready" \
  || die "ready login is not 200 customer bjh003@example.com; see $ready"
"$(dirname "$0")/api.sh" POST /api/auth/logout ready > "$STATE/ready-logout.http"
cat "$STATE/ready-logout.http" >> "$ready"
grep -q '^HTTP/1.1 204' "$STATE/ready-logout.http" || die "ready logout is not 204; see $ready"
rm -f "$STATE/ready-logout.http" "$STATE/jars/ready.txt"

cat <<EOF
READY
  run id    $RUN_ID
  web       $web_origin
  api       $api_origin
  postgres  127.0.0.1:$pg_port (container $container)
  state     $STATE (secrets, pids; removed by cleanup.sh)
  evidence  $EVIDENCE (kept)
$RUN_ID
EOF
