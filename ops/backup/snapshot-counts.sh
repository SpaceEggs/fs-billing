#!/usr/bin/env bash
# 全库快照（阶段 10 验收 3）：余额、流水合计、各表与各分区的行数、归档清单与归档目录。
# 输出是确定性的纯文本（不含时间戳与主机名），所以「恢复前 > before.txt、恢复后 > after.txt」
# 后可直接 diff；整份输出的 sha256 打到标准错误，不混进正文。
#
#   ops/backup/snapshot-counts.sh [--database <库名>] [--archive-dir <目录>] [--config <文件>]
#
# 以 owner 连接（DATABASE_URL 来自 owner.env），绕过 RLS 读全库。
# 任一租户的余额与流水合计不等时仍然打印全部内容，但退出非零。
set -euo pipefail
umask 077

config_file=/etc/fs-billing/backup.conf
database=''
archive_dir=''

usage() {
  cat <<'EOF'
用法：snapshot-counts.sh [--database <库名>] [--archive-dir <目录>] [--config <文件>]

  --database     默认取 owner.env 的 DATABASE_URL；恢复校验时指向临时库
  --archive-dir  默认取配置里的 ARCHIVE_DIR

输出余额与流水合计、各表与分区行数、归档清单与归档目录统计；sha256 写到标准错误。
余额与流水合计不一致时退出非零。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --database)
      (($# >= 2)) || fail '--database 需要库名'
      database=$2
      shift 2
      ;;
    --archive-dir)
      (($# >= 2)) || fail '--archive-dir 需要目录'
      archive_dir=$2
      shift 2
      ;;
    --config)
      (($# >= 2)) || fail '--config 需要文件路径'
      config_file=$2
      shift 2
      ;;
    *)
      usage >&2
      fail "未知参数：$1"
      ;;
  esac
done

[[ -r $config_file ]] || fail "读不到配置文件：$config_file（示例见 backup.conf.example）"

# shellcheck source=/dev/null
. "$config_file"

ARCHIVE_DIR=${ARCHIVE_DIR:-/var/lib/fs-billing/archive}
OWNER_ENV_FILE=${OWNER_ENV_FILE:-/etc/fs-billing/owner.env}

command -v psql >/dev/null 2>&1 || fail '缺少命令：psql（Debian 包 postgresql-client-17）'
[[ -r $OWNER_ENV_FILE ]] || fail "读不到 owner 环境文件：$OWNER_ENV_FILE"
# shellcheck source=/dev/null
. "$OWNER_ENV_FILE"
[[ -n ${DATABASE_URL:-} ]] || fail "owner 环境文件里没有 DATABASE_URL：$OWNER_ENV_FILE"

# 把 DATABASE_URL 拆成 PG* 环境变量：连接串只进环境，密码不进命令行与日志。
parse_database_url() {
  local url=${DATABASE_URL#postgresql://} query=''
  url=${url#postgres://}
  if [[ $url == *\?* ]]; then
    query=${url#*\?}
    url=${url%%\?*}
  fi
  local authority=${url%%/*}
  [[ $authority != "$url" ]] ||
    fail 'DATABASE_URL 缺少库名：需要 postgresql://用户:密码@主机:端口/库名'
  local target=${url#*/}
  local userinfo='' hostport=$authority
  if [[ $authority == *@* ]]; then
    userinfo=${authority%@*}
    hostport=${authority##*@}
  fi
  local user='' password=''
  if [[ -n $userinfo ]]; then
    user=${userinfo%%:*}
    if [[ $userinfo == *:* ]]; then
      password=${userinfo#*:}
    fi
  fi
  local host=${hostport%%:*} port=''
  if [[ $hostport == *:* ]]; then
    port=${hostport##*:}
  fi
  [[ -n $host ]] || fail 'DATABASE_URL 解析失败：主机为空（检查 owner.env 的写法）'

  PGUSER=$(printf '%b' "${user//%/\\x}")
  if [[ -n $password ]]; then
    PGPASSWORD=$(printf '%b' "${password//%/\\x}")
  fi
  PGHOST=$host
  PGPORT=${port:-5432}
  PGDATABASE=$(printf '%b' "${target//%/\\x}")
  case $query in
    *sslmode=*)
      PGSSLMODE=${query#*sslmode=}
      PGSSLMODE=${PGSSLMODE%%&*}
      ;;
  esac
  export PGUSER PGHOST PGPORT PGDATABASE
  [[ -z ${PGPASSWORD:-} ]] || export PGPASSWORD
  [[ -z ${PGSSLMODE:-} ]] || export PGSSLMODE
}

parse_database_url

if [[ -n $database ]]; then
  [[ $database =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "--database 不合法：$database"
  PGDATABASE=$database
  export PGDATABASE
fi
export PGAPPNAME=fs-billing-snapshot
[[ -n $archive_dir ]] || archive_dir=$ARCHIVE_DIR

body=$(mktemp)
trap 'rm -f -- "$body"' EXIT

query() {
  psql --no-psqlrc --no-password -X --no-align --tuples-only --field-separator=$'\t' "$@"
}

{
  printf '# fs-billing 备份快照（owner 读取，绕过 RLS）\n'
  printf '# tenant_balance\t租户编码\t余额\t流水合计\t是否一致\n'
  query <<'SQL'
SELECT 'tenant_balance', t.code, b.balance::text,
       COALESCE(SUM(l.amount), 0)::text,
       CASE WHEN b.balance = COALESCE(SUM(l.amount), 0) THEN 'ok' ELSE 'mismatch' END
FROM tenant_balances b
JOIN tenants t ON t.id = b.tenant_id
LEFT JOIN ledger_entries l ON l.tenant_id = t.id
GROUP BY t.code, b.balance
ORDER BY t.code;
SQL
} >"$body"

mismatch=$(grep -c $'\tmismatch$' "$body" || true)
printf 'balance_mismatch=%s\n' "$mismatch" >>"$body"

{
  printf '# 行数：父表与按北京月的分区\n'
  query <<'SQL'
SELECT kind, name, value FROM (
  SELECT 1 AS k, 'table' AS kind, 'cdrs' AS name, count(*)::text AS value FROM cdrs
  UNION ALL SELECT 2, 'table', 'ledger_entries', count(*)::text FROM ledger_entries
  UNION ALL SELECT 3, 'table', 'raw_cdrs', count(*)::text FROM raw_cdrs
  UNION ALL SELECT 4, 'table', 'unassigned_cdrs', count(*)::text FROM unassigned_cdrs
  UNION ALL SELECT 5, 'table', 'call_uuids', count(*)::text FROM call_uuids
  UNION ALL SELECT 6, 'table', 'system_alerts', count(*)::text FROM system_alerts
  UNION ALL SELECT 7, 'table', 'email_outbox', count(*)::text FROM email_outbox
) rows
ORDER BY k;
SQL
} >>"$body"

mapfile -t partitions < <(
  query -c "
    SELECT child.relname
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_class child ON child.oid = i.inhrelid
    WHERE parent.relname IN ('cdrs', 'raw_cdrs')
    ORDER BY parent.relname, child.relname"
)
for partition in "${partitions[@]}"; do
  count=$(query -c "SELECT count(*) FROM \"$partition\"")
  printf 'partition\t%s\t%s\n' "$partition" "$count" >>"$body"
done

{
  printf '# 原始话单归档清单\n'
  query <<'SQL'
SELECT 'raw_cdr_archives', state, count(*)::text
FROM raw_cdr_archives
GROUP BY state
ORDER BY state;
SQL
} >>"$body"

{
  printf '# 归档目录\n'
  printf 'archive_dir\t%s\n' "$archive_dir"
  if [[ -d $archive_dir ]]; then
    files=$(find "$archive_dir" -type f -printf '.' | wc -c)
    bytes=$(find "$archive_dir" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
    printf 'archive_files\t%s\n' "$files"
    printf 'archive_bytes\t%s\n' "$bytes"
  else
    printf 'archive_files\tmissing\n'
    printf 'archive_bytes\tmissing\n'
  fi
} >>"$body"

sha=$(sha256sum "$body" | awk '{ print $1 }')
cat "$body"
printf '输出 sha256：%s\n' "$sha" >&2

if ((mismatch > 0)); then
  printf '余额与流水合计不一致：%s 个租户\n' "$mismatch" >&2
  exit 1
fi
