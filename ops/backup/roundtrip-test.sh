#!/usr/bin/env bash
# CI 往返测试（阶段 10 验收 3）。对一台一次性 PostgreSQL 执行全部迁移、造数（含分区表行与
# 一个归档文件）、备份、恢复到另一个库、比对快照，并证明：
#   1. 没有 --i-know-this-drops-the-database 时 --restore 拒绝覆盖非空库，且目标库未被改动；
#   2. 损坏的 dump 不能通过 --verify；
#   3. verify-restore.sh 先用 SHA256SUMS 校验，再调用 --verify；
#   4. 保留策略按整套删除过期备份，且无论时钟如何都至少保留 MIN_KEEP 套；
#   5. --verify 不会删除已存在的真实库（只重建 fs_billing_verify 或以 _verify 结尾的临时库）。
#
# 只在一次性数据库上运行：会执行 packages/db/migrations 下全部迁移并写入测试租户。
# 第 1 步会 DROP 并重建 ROUNDTRIP_DB，所以必须显式设 ROUNDTRIP_ALLOW_DESTRUCTIVE=1。
# 由 .github/workflows/ci.yml 的 backup-roundtrip 作业在 debian:13 容器里调用；
# 本机可用同一条 docker run 复现（命令见工作流）。
set -euo pipefail
umask 077

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

# $1 是说明，其余是要执行的命令。
must_fail() {
  local label=$1
  shift
  if "$@"; then
    fail "$label：命令意外成功"
  fi
  log "已拒绝：$label"
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
migrations_dir=${MIGRATIONS_DIR:-/w/packages/db/migrations}
owner=${PGUSER:-fs_billing}
host=${PGHOST:-127.0.0.1}
port=${PGPORT:-5432}
db=${ROUNDTRIP_DB:-fs_billing}
verify_db=${ROUNDTRIP_VERIFY_DB:-fs_billing_verify}
# 名字不以 _verify 结尾：--verify 必须拒绝删它（第 13 步）。
real_db=${ROUNDTRIP_REAL_DB:-fs_billing_roundtrip_real}

# 第 1 步会 DROP 并重建 ROUNDTRIP_DB；确认是一次性库才允许运行。
[[ ${ROUNDTRIP_ALLOW_DESTRUCTIVE:-0} == 1 ]] || fail \
  '本脚本会删除并重建 ROUNDTRIP_DB，只用于一次性库；确认后设 ROUNDTRIP_ALLOW_DESTRUCTIVE=1'

[[ -d $migrations_dir ]] || fail "找不到迁移目录：$migrations_dir"
command -v psql >/dev/null 2>&1 || fail '缺少命令：psql（Debian 包 postgresql-client-17）'

work_root=${WORK_ROOT:-}
if [[ -z $work_root ]]; then
  work_root=$(mktemp -d)
  created_work_root=1
else
  created_work_root=0
  install -d -m 0700 "$work_root"
fi

# 测试库的连接串只用于 owner.env；实际连接走 PGHOST/PGUSER/PGPASSWORD 环境变量。
database_url() {
  printf 'postgresql://%s:%s@%s:%s/%s' "$owner" "${PGPASSWORD:-}" "$host" "$port" "$1"
}

psql_admin() {
  PGDATABASE=postgres psql --no-psqlrc --no-password -X -v ON_ERROR_STOP=1 "$@"
}

psql_db() {
  local target=$1
  shift
  PGDATABASE=$target psql --no-psqlrc --no-password -X -v ON_ERROR_STOP=1 "$@"
}

# 造一套假的完整备份。保留策略只认文件名里的时间戳（不信 mtime），所以内容无所谓。
make_fake_set() {
  local dir=$1 stamp=$2 artifact
  for artifact in \
    "fs_billing-$stamp.dump" \
    "globals-$stamp.sql" \
    "archive-$stamp.tar.gz" \
    "config-$stamp.tar.gz" \
    "SHA256SUMS-$stamp"; do
    printf 'fake\n' >"$dir/$artifact"
    chmod 0600 "$dir/$artifact"
  done
}

# 列出备份目录里每一套的时间戳，按文件名排序。
stamps_of() {
  find "$1" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%f\n' |
    sed 's/^fs_billing-//; s/\.dump$//' | sort
}

# 一套完整备份应有的五个文件。
set_files() {
  local stamp=$1
  printf '%s\n' \
    "fs_billing-$stamp.dump" \
    "globals-$stamp.sql" \
    "archive-$stamp.tar.gz" \
    "config-$stamp.tar.gz" \
    "SHA256SUMS-$stamp"
}

cleanup() {
  psql_admin -q -c "DROP DATABASE IF EXISTS \"$verify_db\" WITH (FORCE)" >/dev/null 2>&1 || true
  psql_admin -q -c "DROP DATABASE IF EXISTS \"$real_db\" WITH (FORCE)" >/dev/null 2>&1 || true
  if ((created_work_root)); then
    rm -rf -- "$work_root"
  fi
}
trap cleanup EXIT

log "工作目录：$work_root"

log '1. 重建一次性数据库'
case $db in
  postgres | template0 | template1) fail "不能重建系统库：$db" ;;
esac
psql_admin -q -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)"
psql_admin -q -c "CREATE DATABASE \"$db\""

log '2. 应用全部迁移'
for file in "$migrations_dir"/*.sql; do
  if ! psql_db "$db" -q -f "$file" >/dev/null 2>"$work_root/migrate.err"; then
    cat "$work_root/migrate.err" >&2
    fail "迁移失败：$file"
  fi
done

log '3. 造数：租户、流水、话单（分区表）、原始话单、未归属话单、归档清单'
psql_db "$db" -q <<'SQL'
BEGIN;
\o /dev/null
SELECT set_config('app.scope', 'system', true);
SELECT ensure_month_partition('cdrs', TIMESTAMPTZ '2026-10-15 00:00:00+08');
SELECT ensure_month_partition('raw_cdrs', TIMESTAMPTZ '2026-10-15 00:00:00+08');
\o
COMMIT;

INSERT INTO tenants (code, name, currency, overdraft_limit)
VALUES ('P10CI', '阶段十往返测试', 'CNY', '100.00');
SQL

psql_db "$db" -q <<'SQL'
BEGIN;
\o /dev/null
SELECT set_config('app.scope', 'admin', true);
SELECT lock_tenants(ARRAY[(SELECT id FROM tenants WHERE code = 'P10CI')]);
\o
INSERT INTO ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key,
                            occurred_at, created_at)
VALUES ((SELECT id FROM tenants WHERE code = 'P10CI'), 'call_charge', '-1.23', 'CI 往返', NULL,
        'ci:p10:call:1', '2026-10-15 10:01:00+08', '2026-10-15 10:01:03+08');
INSERT INTO cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
                  billing_number, duration_seconds, billed_minutes, matched_prefix, country,
                  rate, charge, hangup_cause)
VALUES ((SELECT id FROM tenants WHERE code = 'P10CI'),
        'c1c1c1c1-0000-4000-8000-000000000001',
        '2026-10-15 10:00:00+08', '2026-10-15 10:00:05+08', '2026-10-15 10:01:05+08',
        '07550000000', '8613800000000', '8613800000000', 60, 1, '86', '中国', 0.0500, 0.05,
        'NORMAL_CLEARING');
COMMIT;

INSERT INTO raw_cdrs (id, body, received_at)
VALUES ('c2c2c2c2-0000-4000-8000-000000000002',
        '{"call_uuid":"c1c1c1c1-0000-4000-8000-000000000001"}', '2026-10-15 10:01:10+08');

INSERT INTO unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, ended_at, caller,
                             callee, billing_number, status)
VALUES ('P10XX', 'c3c3c3c3-0000-4000-8000-000000000003', '租户不存在',
        '2026-10-15 11:00:00+08', '2026-10-15 11:01:00+08', '07550000001', '8613800000001',
        '8613800000001', 'pending');
SQL

install -d -m 0700 "$work_root/archive" "$work_root/configsrc" "$work_root/release"
printf 'selftest\n' >"$work_root/configsrc/fs-billing.conf"
printf '{"id":"c2c2c2c2-0000-4000-8000-000000000002","received_at":"2026-09-01T00:00:00.000000Z"}\n' |
  gzip -n >"$work_root/archive/raw_cdrs_2026-09.jsonl.gz"
archive_sha=$(sha256sum "$work_root/archive/raw_cdrs_2026-09.jsonl.gz" | awk '{ print $1 }')
archive_bytes=$(stat -c %s "$work_root/archive/raw_cdrs_2026-09.jsonl.gz")
psql_db "$db" -q -v archive_sha="$archive_sha" -v archive_bytes="$archive_bytes" <<'SQL'
INSERT INTO raw_cdr_archives (month, state, file_key, rows, body_bytes, file_bytes,
                              file_sha256, rows_digest, db_fingerprint, chunks, verified_at)
VALUES ('2026-09-01', 'verified', 'raw_cdrs_2026-09.jsonl.gz', 1, 84, :'archive_bytes',
        :'archive_sha', repeat('a', 64), '{}'::jsonb, '[]'::jsonb, now());
SQL

cdr_rows=$(psql_db "$db" -Atc 'SELECT count(*) FROM cdrs')
raw_rows=$(psql_db "$db" -Atc 'SELECT count(*) FROM raw_cdrs')
((cdr_rows > 0 && raw_rows > 0)) || fail '分区表里没有测试行'
log "   cdrs=$cdr_rows raw_cdrs=$raw_rows"

log '4. 写备份配置与 owner.env'
printf 'DATABASE_URL=%s\n' "$(database_url "$db")" >"$work_root/owner.env"
chmod 0600 "$work_root/owner.env"
{
  printf 'BACKUP_DIR=%s\n' "$work_root/backups"
  printf 'ARCHIVE_DIR=%s\n' "$work_root/archive"
  printf 'ARCHIVE_OWNER=root\n'
  printf 'CONFIG_PATHS=(%s)\n' "$work_root/configsrc"
  printf 'DB_OWNER=%s\n' "$owner"
  printf 'RETENTION_DAYS=30\n'
  printf 'MIN_KEEP=3\n'
  printf 'OFFSITE_COMMAND=\n'
  printf 'OWNER_ENV_FILE=%s\n' "$work_root/owner.env"
  printf 'RELEASE_DIR=%s\n' "$work_root/release"
} >"$work_root/backup.conf"

log '5. 备份'
"$script_dir/backup.sh" --config "$work_root/backup.conf"
[[ $(stat -c %a "$work_root/backups") == 700 ]] || fail '备份目录不是 700'
for artifact in "$work_root"/backups/*; do
  [[ $(stat -c %a "$artifact") == 600 ]] || fail "$artifact 不是 600"
done
grep -q '"tocEntries": [1-9]' "$work_root/backups/LATEST.json" || fail 'LATEST.json 没有条目数'
dump=$(find "$work_root/backups" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%p\n' |
  sort | tail -n 1)
[[ -n $dump ]] || fail '没有生成库备份'

log '6. 备份前快照，恢复到临时库，比对'
"$script_dir/snapshot-counts.sh" --config "$work_root/backup.conf" >"$work_root/before.txt"
"$script_dir/restore.sh" --verify --config "$work_root/backup.conf" --dump "$dump" \
  --report "$work_root/after.txt"
if ! diff -u "$work_root/before.txt" "$work_root/after.txt"; then
  fail '恢复前后的快照不一致'
fi
log '   快照一致'
psql_admin -Atc "SELECT 1 FROM pg_database WHERE datname = '$verify_db'" | grep -q 1 &&
  fail '--verify 结束后临时库还在'

log '7. 没有显式开关或目标库时拒绝 --restore'
must_fail '缺少 --target-db 的 --restore' \
  "$script_dir/restore.sh" --restore --i-know-this-drops-the-database \
  --config "$work_root/backup.conf" --dump "$dump"
must_fail '无开关的 --restore' \
  "$script_dir/restore.sh" --restore --target-db "$verify_db" \
  --config "$work_root/backup.conf" --dump "$dump"
psql_admin -Atc "SELECT 1 FROM pg_database WHERE datname = '$verify_db'" | grep -q 1 &&
  fail '被拒绝的 --restore 仍然创建了目标库'

log '8. 带开关恢复到一个非空的临时库，再证明无开关拒绝且库不变'
"$script_dir/restore.sh" --restore --target-db "$verify_db" \
  --i-know-this-drops-the-database --config "$work_root/backup.conf" --dump "$dump"
"$script_dir/snapshot-counts.sh" --config "$work_root/backup.conf" --database "$verify_db" \
  >"$work_root/after-restore.txt"
if ! diff -u "$work_root/before.txt" "$work_root/after-restore.txt"; then
  fail '--restore 后的快照不一致'
fi
before_count=$(psql_db "$verify_db" -Atc 'SELECT count(*) FROM tenants')
must_fail '覆盖非空库（无开关）' \
  "$script_dir/restore.sh" --restore --target-db "$verify_db" \
  --config "$work_root/backup.conf" --dump "$dump"
after_count=$(psql_db "$verify_db" -Atc 'SELECT count(*) FROM tenants')
[[ $before_count == "$after_count" ]] ||
  fail "被拒绝的 --restore 改动了目标库：$before_count -> $after_count"
log "   非空库未被改动（tenants=$after_count）"

log '9. 损坏的 dump 不能通过 --verify'
cp "$dump" "$work_root/corrupt.dump"
printf 'not-a-dump' | dd of="$work_root/corrupt.dump" bs=1 seek=64 conv=notrunc status=none
must_fail '损坏的 dump' \
  "$script_dir/restore.sh" --verify --config "$work_root/backup.conf" --dump "$work_root/corrupt.dump"
psql_admin -Atc "SELECT 1 FROM pg_database WHERE datname = '$verify_db'" | grep -q 1 &&
  fail '校验失败后临时库还留着'

log '10. verify-restore.sh：校验和 + 恢复校验'
psql_admin -q -c "DROP DATABASE IF EXISTS \"$verify_db\" WITH (FORCE)"
"$script_dir/verify-restore.sh" --config "$work_root/backup.conf" --dump "$dump"

log '11. 损坏的副本被 SHA256SUMS 拦下'
stamp2=20990101T000000Z
stamp=${dump##*/fs_billing-}
stamp=${stamp%.dump}
for kind in globals archive config; do
  case $kind in
    globals) extension=sql ;;
    archive | config) extension=tar.gz ;;
  esac
  cp "$work_root/backups/$kind-$stamp.$extension" "$work_root/backups/$kind-$stamp2.$extension"
done
cp "$dump" "$work_root/backups/fs_billing-$stamp2.dump"
(
  cd "$work_root/backups"
  sha256sum "fs_billing-$stamp2.dump" "globals-$stamp2.sql" \
    "archive-$stamp2.tar.gz" "config-$stamp2.tar.gz" >"SHA256SUMS-$stamp2"
)
printf 'x' | dd of="$work_root/backups/fs_billing-$stamp2.dump" bs=1 seek=64 conv=notrunc status=none
must_fail '校验和不符的副本' \
  "$script_dir/verify-restore.sh" --config "$work_root/backup.conf" \
  --dump "$work_root/backups/fs_billing-$stamp2.dump"

log '12. 保留策略：过期备份按整套删除，且至少保留最近 MIN_KEEP 套'
retention_dir=$work_root/retention
install -d -m 0700 "$retention_dir/backups"
sed "s|^BACKUP_DIR=.*|BACKUP_DIR=$retention_dir/backups|" \
  "$work_root/backup.conf" >"$retention_dir/backup.conf"

# 先用 5 套 30 天前的备份 + 本次新备份（共 6 套）验证「多删一套」的边界。
old_stamps=(
  20200101T000000Z 20200102T000000Z 20200103T000000Z 20200104T000000Z 20200105T000000Z
)
for stamp in "${old_stamps[@]}"; do
  make_fake_set "$retention_dir/backups" "$stamp"
done
"$script_dir/backup.sh" --config "$retention_dir/backup.conf" >/dev/null
mapfile -t kept < <(stamps_of "$retention_dir/backups")
[[ ${#kept[@]} == 3 ]] ||
  fail "保留策略应留下 3 套，实际 ${#kept[@]} 套：${kept[*]}"
[[ ${kept[0]} == "${old_stamps[3]}" && ${kept[1]} == "${old_stamps[4]}" ]] ||
  fail "保留策略留下的旧备份不对：${kept[*]}"
[[ ${kept[2]} =~ ^[0-9]{8}T[0-9]{6}Z$ && ${kept[2]} > ${old_stamps[4]} ]] ||
  fail "最新一套不是本次新备份：${kept[2]}"
# 删掉的 3 套必须一个文件都不剩，留下的每套必须完整。
for stamp in "${old_stamps[@]:0:3}"; do
  while IFS= read -r artifact; do
    [[ ! -e $retention_dir/backups/$artifact ]] ||
      fail "过期备份 $stamp 还留着 $artifact"
  done < <(set_files "$stamp")
done
for stamp in "${kept[@]}"; do
  while IFS= read -r artifact; do
    [[ -e $retention_dir/backups/$artifact ]] || fail "留下的备份 $stamp 缺少 $artifact"
  done < <(set_files "$stamp")
done
log "   留下 ${kept[*]}；${old_stamps[0]} 至 ${old_stamps[2]} 三套的文件已全部删除"

# 再模拟时钟错误：运行前所有备份看起来都过期了（没有任何近期的可留），
# 保留策略仍必须留下最近 MIN_KEEP 套，不能删光。
wrong_clock_dir=$work_root/wrong-clock
install -d -m 0700 "$wrong_clock_dir/backups"
sed "s|^BACKUP_DIR=.*|BACKUP_DIR=$wrong_clock_dir/backups|" \
  "$work_root/backup.conf" >"$wrong_clock_dir/backup.conf"
old_clock=(
  20100101T000000Z 20100102T000000Z 20100103T000000Z
  20100104T000000Z 20100105T000000Z 20100106T000000Z
)
for stamp in "${old_clock[@]}"; do
  make_fake_set "$wrong_clock_dir/backups" "$stamp"
done
"$script_dir/backup.sh" --config "$wrong_clock_dir/backup.conf" >/dev/null
mapfile -t kept < <(stamps_of "$wrong_clock_dir/backups")
(( ${#kept[@]} >= 3 )) ||
  fail "时钟错误时也必须至少保留 3 套，实际 ${#kept[@]} 套：${kept[*]}"
[[ ${#kept[@]} == 3 ]] || fail "应只留下最近 3 套，实际 ${#kept[@]} 套：${kept[*]}"
log "   时钟错误时留下 ${kept[*]}"

log '13. --verify 不能删除已存在的真实库'
psql_admin -q -c "DROP DATABASE IF EXISTS \"$real_db\" WITH (FORCE)"
psql_admin -q -c "CREATE DATABASE \"$real_db\""
psql_db "$real_db" -q -c 'CREATE TABLE keep_me (id integer PRIMARY KEY)'
psql_db "$real_db" -q -c 'INSERT INTO keep_me VALUES (42)'
must_fail '--verify 指向已存在的真实库' \
  "$script_dir/restore.sh" --verify --target-db "$real_db" \
  --config "$work_root/backup.conf" --dump "$dump"
psql_admin -Atc "SELECT 1 FROM pg_database WHERE datname = '$real_db'" | grep -q 1 ||
  fail "--verify 删掉了真实库 $real_db"
[[ $(psql_db "$real_db" -Atc 'SELECT id FROM keep_me') == 42 ]] ||
  fail "--verify 改动了真实库 $real_db"
psql_admin -q -c "DROP DATABASE \"$real_db\" WITH (FORCE)"
log "   真实库 $real_db 未被改动"

log '全部通过：备份 → 恢复 → 快照一致；无开关拒绝覆盖；损坏的 dump 被拒绝；保留策略与 --verify 目标受控'
