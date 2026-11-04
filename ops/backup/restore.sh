#!/usr/bin/env bash
# 从备份恢复数据库（阶段 10 验收 3）。
#
#   ops/backup/restore.sh --verify [--dump <文件>] [--report <文件>]
#   ops/backup/restore.sh --restore --target-db <库名> --i-know-this-drops-the-database [--dump <文件>]
#
# --verify：恢复到一个临时库（默认 fs_billing_verify），跑 snapshot-counts.sh 与账本不变量
#           检查后删除临时库，不碰生产库。每周由 fs-billing-backup-verify.timer 调用。
# --restore：完整恢复。必须显式给出目标库，并且必须带 --i-know-this-drops-the-database。
#           目标就是生产库时，先停 API 与 Worker，把现库改名为 fs_billing_pre_restore_<时间>
#           （改名，不删除），再恢复、重设角色密码、安装队列、解回归档目录、启动服务并做健康检查。
#
# 生产库永远不会是默认目标：不带 --target-db 的 --restore 一律拒绝。
# 连接串只从 owner.env 的 DATABASE_URL 读取，只进环境变量，不进命令行和日志。
set -euo pipefail
umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config_file=/etc/fs-billing/backup.conf
mode=''
target=''
dump=''
report=''
archive_tar=''
confirmed=0
verify_db=''

usage() {
  cat <<'EOF'
用法：
  restore.sh --verify  [--dump <文件>] [--report <文件>] [--config <文件>]
  restore.sh --restore --target-db <库名> --i-know-this-drops-the-database [--dump <文件>] [--config <文件>]

--verify 恢复到临时库（默认 fs_billing_verify），校验后删除，不碰生产库。
--restore 必须显式指定 --target-db；生产库不是默认目标。
不带 --i-know-this-drops-the-database 的 --restore 会被拒绝。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

while (($#)); do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --verify)
      [[ -z $mode ]] || fail '只能选 --verify 或 --restore 之一'
      mode=verify
      shift
      ;;
    --restore)
      [[ -z $mode ]] || fail '只能选 --verify 或 --restore 之一'
      mode=restore
      shift
      ;;
    --target-db)
      (($# >= 2)) || fail '--target-db 需要库名'
      target=$2
      shift 2
      ;;
    --dump)
      (($# >= 2)) || fail '--dump 需要文件路径'
      dump=$2
      shift 2
      ;;
    --report)
      (($# >= 2)) || fail '--report 需要文件路径'
      report=$2
      shift 2
      ;;
    --archive-tar)
      (($# >= 2)) || fail '--archive-tar 需要文件路径'
      archive_tar=$2
      shift 2
      ;;
    --i-know-this-drops-the-database)
      confirmed=1
      shift
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

[[ -n $mode ]] || {
  usage >&2
  fail '必须指定 --verify 或 --restore'
}
[[ -r $config_file ]] || fail "读不到配置文件：$config_file（示例见 backup.conf.example）"

# shellcheck source=/dev/null
. "$config_file"

BACKUP_DIR=${BACKUP_DIR:-/root/backups}
ARCHIVE_DIR=${ARCHIVE_DIR:-/var/lib/fs-billing/archive}
ARCHIVE_OWNER=${ARCHIVE_OWNER:-fs-billing}
DB_OWNER=${DB_OWNER:-fs_billing}
OWNER_ENV_FILE=${OWNER_ENV_FILE:-/etc/fs-billing/owner.env}
RELEASE_DIR=${RELEASE_DIR:-/opt/fs-billing/current}

for command in pg_restore psql createdb dropdb sha256sum date tar; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command（Debian 包 postgresql-client-17）"
done

[[ -r $OWNER_ENV_FILE ]] || fail "读不到 owner 环境文件：$OWNER_ENV_FILE"
# shellcheck source=/dev/null
. "$OWNER_ENV_FILE"
[[ -n ${DATABASE_URL:-} ]] || fail "owner 环境文件里没有 DATABASE_URL：$OWNER_ENV_FILE"
export PGAPPNAME=fs-billing-restore

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
  local database=${url#*/}
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
  PGDATABASE=$(printf '%b' "${database//%/\\x}")
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

psql_at() {
  local database=$1
  shift
  PGDATABASE=$database psql --no-psqlrc --no-password -X "$@"
}

validate_identifier() {
  local name=$1 what=$2
  [[ $name =~ ^[a-z_][a-z0-9_]{0,62}$ ]] ||
    fail "$what 不合法：$name（只允许小写字母、数字、下划线，最长 63）"
}

db_exists() {
  local database=$1
  [[ $(psql_at postgres -Atc "SELECT 1 FROM pg_database WHERE datname = '$database'") == 1 ]]
}

# 用户表数量：用于判断一个已存在的库是不是非空。
db_object_count() {
  local database=$1
  psql_at "$database" -Atc "
    SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')"
}

latest_dump() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%f\n' |
    sort | tail -n 1
}

stop_services() {
  command -v systemctl >/dev/null 2>&1 ||
    fail '找不到 systemctl：恢复生产库前必须能停止 API 与 Worker'
  systemctl cat fs-billing-api >/dev/null 2>&1 ||
    fail '找不到 fs-billing-api 单元：目标不是本机生产库时请用 --verify 或另一个 --target-db'
  systemctl cat fs-billing-worker >/dev/null 2>&1 ||
    fail '找不到 fs-billing-worker 单元：目标不是本机生产库时请用 --verify 或另一个 --target-db'
  systemctl stop fs-billing-api fs-billing-worker
  log '已停止 fs-billing-api 与 fs-billing-worker'
}

run_app_migrations() {
  [[ -d $RELEASE_DIR ]] || fail "找不到发布目录 $RELEASE_DIR：无法重设角色密码与安装队列"
  command -v pnpm >/dev/null 2>&1 || fail '找不到 pnpm：无法执行 db:migrate 与 queue:migrate'
  log '重设应用角色密码并安装 pg-boss 队列'
  (
    cd "$RELEASE_DIR" || fail "进不去 $RELEASE_DIR"
    set -a
    # shellcheck source=/dev/null
    . "$OWNER_ENV_FILE"
    set +a
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
    pnpm db:migrate
    pnpm --filter @fs-billing/worker queue:migrate
  )
}

start_services() {
  local api_host api_port worker_host worker_port
  command -v curl >/dev/null 2>&1 || fail '找不到 curl：无法做健康检查'
  systemctl start fs-billing-api fs-billing-worker
  log '已启动 fs-billing-api 与 fs-billing-worker'

  [[ -r /etc/fs-billing/app.env ]] || fail '读不到 /etc/fs-billing/app.env：无法做健康检查'
  api_host=$(sed -n 's/^API_HOST=//p' /etc/fs-billing/app.env | tail -n 1)
  api_port=$(sed -n 's/^API_PORT=//p' /etc/fs-billing/app.env | tail -n 1)
  worker_host=$(sed -n 's/^WORKER_HOST=//p' /etc/fs-billing/app.env | tail -n 1)
  worker_port=$(sed -n 's/^WORKER_PORT=//p' /etc/fs-billing/app.env | tail -n 1)
  api_host=${api_host:-127.0.0.1}
  api_port=${api_port:-3000}
  worker_host=${worker_host:-127.0.0.1}
  worker_port=${worker_port:-3001}

  wait_http() {
    local label=$1 url=$2
    for _ in $(seq 1 30); do
      if curl --noproxy '*' --fail --silent --show-error --max-time 5 \
        --output /dev/null "$url" 2>/dev/null; then
        log "健康检查通过：$label（$url）"
        return 0
      fi
      sleep 1
    done
    log "健康检查失败：$label（$url）" >&2
    return 1
  }

  wait_http API "http://$api_host:$api_port/api/health" ||
    fail 'API 没有通过健康检查：看 journalctl -u fs-billing-api'
  wait_http Worker "http://$worker_host:$worker_port/health" ||
    fail 'Worker 没有通过健康检查：看 journalctl -u fs-billing-worker'
}

# 角色备份里的 CREATE ROLE 对已存在的角色会报错；按设计跳过这些，其他错误一律失败。
import_globals() {
  local file=$1 errors unexpected status=0
  if [[ ! -r $file ]]; then
    log "警告：没有角色备份 $file，跳过 globals；恢复到新机器会因缺少角色失败" >&2
    return 0
  fi
  log "导入角色 $file（已存在的跳过）"
  errors=$(mktemp)
  psql_at postgres -v ON_ERROR_STOP=0 -q -f "$file" >/dev/null 2>"$errors" || status=$?
  unexpected=$(grep -vE 'role ".*" already exists' "$errors" || true)
  if [[ -n $unexpected ]]; then
    printf '%s\n' "$unexpected" >&2
    rm -f -- "$errors"
    fail "导入角色失败（exit $status）"
  fi
  rm -f -- "$errors"
}

restore_dump() {
  local database=$1 file=$2
  log "恢复 $file -> $database"
  PGDATABASE=$database pg_restore \
    --no-password --exit-on-error --single-transaction --dbname="$database" "$file"
}

find_matching_archive() {
  local stamp=$1
  local candidate=$BACKUP_DIR/archive-$stamp.tar.gz
  if [[ -r $candidate ]]; then
    printf '%s' "$candidate"
  fi
  return 0
}

dump_stamp() {
  local base=${1##*/} stamp
  stamp=${base#fs_billing-}
  stamp=${stamp%.dump}
  [[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "备份文件名里没有可识别的时间戳：$1"
  printf '%s' "$stamp"
}

live_db=$PGDATABASE
validate_identifier "$live_db" 'DATABASE_URL 里的库名'

if [[ -z $dump ]]; then
  dump_name=$(latest_dump)
  [[ -n $dump_name ]] || fail "在 $BACKUP_DIR 里找不到 fs_billing-*.dump"
  dump=$BACKUP_DIR/$dump_name
fi
[[ -r $dump ]] || fail "读不到备份文件：$dump"

# ---------------------------------------------------------------- --verify
if [[ $mode == verify ]]; then
  [[ -n $target ]] || target=fs_billing_verify
  validate_identifier "$target" '--target-db'
  [[ $target != "$live_db" ]] || fail "拒绝把 --verify 恢复到生产库 $live_db"
  case $target in
    postgres | template0 | template1) fail "不能使用系统库名：$target" ;;
  esac

  cleanup_verify() {
    if [[ -n $verify_db ]]; then
      PGDATABASE=postgres dropdb --if-exists --force "$verify_db" >/dev/null 2>&1 || true
      verify_db=''
    fi
  }
  trap cleanup_verify EXIT

  if db_exists "$target"; then
    # 只有默认的临时库或以 _verify 结尾的名字才允许删掉重建：
    # --verify --target-db <真实库> 若照删，就是一次没有确认的删库。
    case $target in
      fs_billing_verify | *_verify) ;;
      *)
        fail "拒绝用 --verify 删除已存在的库 $target：--verify 只重建 fs_billing_verify 或以 _verify 结尾的临时库；真实库请用 --restore"
        ;;
    esac
    log "删除上次遗留的临时库 $target"
    PGDATABASE=postgres dropdb --if-exists --force "$target"
  fi
  PGDATABASE=postgres createdb --owner "$DB_OWNER" "$target"
  verify_db=$target

  restore_dump "$target" "$dump"

  snapshot_args=(--config "$config_file" --database "$target")
  if [[ -n $report ]]; then
    if [[ $report != /* ]]; then
      report=$PWD/$report
    fi
    "$script_dir/snapshot-counts.sh" "${snapshot_args[@]}" >"$report"
    chmod 0600 "$report"
    log "恢复后的快照写入 $report"
  else
    "$script_dir/snapshot-counts.sh" "${snapshot_args[@]}" >/dev/null
  fi

  cleanup_verify
  trap - EXIT
  log "恢复校验通过：$dump -> $target（行数与账本不变量一致，临时库已删除）"
  exit 0
fi

# --------------------------------------------------------------- --restore
[[ -n $target ]] || fail \
  '--restore 必须显式给出 --target-db；生产库不是默认目标，请写出库名（例如 --target-db fs_billing）'
validate_identifier "$target" '--target-db'
((confirmed == 1)) || fail \
  '--restore 会覆盖目标库，必须同时带 --i-know-this-drops-the-database；不确定时先用 --verify'

case $target in
  postgres | template0 | template1) fail "不能使用系统库名：$target" ;;
esac

stamp=$(dump_stamp "$dump")
globals_file=$BACKUP_DIR/globals-$stamp.sql
[[ -n $archive_tar ]] || archive_tar=$(find_matching_archive "$stamp")

is_live=0
[[ $target == "$live_db" ]] && is_live=1
pre_restore=''

# 恢复生产库前先做预检：改名之后才发现缺发布目录或 pnpm，会留下停摆的服务器。
if ((is_live)); then
  [[ -d $RELEASE_DIR ]] || fail "找不到发布目录 $RELEASE_DIR：恢复生产库前必须先完成部署"
  command -v pnpm >/dev/null 2>&1 || fail '找不到 pnpm：恢复生产库后要跑 db:migrate 与 queue:migrate'
  command -v curl >/dev/null 2>&1 || fail '找不到 curl：恢复生产库后要做健康检查'
  [[ -r /etc/fs-billing/app.env ]] || fail '读不到 /etc/fs-billing/app.env：恢复生产库后要做健康检查'
fi

# 失败提示：停过服务就说服务停着；改过名才给旧库名。成功时清掉 trap。
# 改名之前失败（例如 ALTER DATABASE 被其他会话挡住）时没有旧库名可给，
# 但操作员同样需要知道 API 与 Worker 已经停了。
recovery_hint() {
  ((is_live)) || return 0
  if [[ -n $pre_restore ]]; then
    printf '恢复未完成：服务保持停止，旧库保留为 %s。修好后重跑本命令，或把它改名回 %s。\n' \
      "$pre_restore" "$target" >&2
  else
    printf '恢复未完成：服务保持停止（fs-billing-api 与 fs-billing-worker 已停），没有旧库改名。修好后重跑本命令。\n' >&2
  fi
}

if [[ -t 0 ]]; then
  printf '即将把 %s 恢复成 %s。输入库名确认：' "$dump" "$target" >&2
  read -r answer
  [[ $answer == "$target" ]] || fail '输入不匹配，已取消'
else
  log '标准输入不是终端：跳过交互确认（--i-know-this-drops-the-database 已给出）'
fi

if ((is_live)); then
  stop_services
  trap recovery_hint EXIT
fi

if db_exists "$target"; then
  objects=$(db_object_count "$target")
  if ((objects > 0)); then
    if ((is_live)); then
      candidate="${target}_pre_restore_$(date -u +%Y%m%dT%H%M%SZ)"
      log "把现库 $target 改名为 $candidate（不删除）"
      psql_at postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE \"$target\" RENAME TO \"$candidate\""
      pre_restore=$candidate
    else
      log "删除目标库 $target（$objects 张表；已给出 --i-know-this-drops-the-database）"
      PGDATABASE=postgres dropdb --if-exists --force "$target"
    fi
  else
    log "目标库 $target 为空，直接重建"
    PGDATABASE=postgres dropdb --if-exists --force "$target"
  fi
fi

import_globals "$globals_file"

PGDATABASE=postgres createdb --owner "$DB_OWNER" "$target"
restore_dump "$target" "$dump"

if ((is_live)); then
  if ! run_app_migrations; then
    printf '恢复已写入 %s，但 db:migrate 或 queue:migrate 失败。\n' "$target" >&2
    printf '旧库保留为 %s；不要启动服务，先修好发布目录再重跑本命令。\n' "$pre_restore" >&2
    exit 1
  fi

  if [[ -n $archive_tar && -r $archive_tar ]]; then
    log "解回归档目录 $ARCHIVE_DIR"
    if [[ ! -d $ARCHIVE_DIR ]]; then
      if id "$ARCHIVE_OWNER" >/dev/null 2>&1; then
        install -d -m 0700 -o "$ARCHIVE_OWNER" -g "$ARCHIVE_OWNER" "$ARCHIVE_DIR"
      else
        install -d -m 0700 "$ARCHIVE_DIR"
      fi
    fi
    # root 解包默认保留归档里的属主（fs-billing），归档文件是只增不改的。
    tar --extract --gzip --file="$archive_tar" --directory="$ARCHIVE_DIR"
  else
    log "警告：没有匹配的归档目录备份（archive-$stamp.tar.gz），跳过；原始话单可能缺失" >&2
  fi

  start_services
  trap - EXIT
  if [[ -n $pre_restore ]]; then
    log "恢复完成：$target（备份时刻之前的旧库留在 $pre_restore）"
  else
    log "恢复完成：$target（新建库，没有需要保留的旧库）"
  fi
  log '备份时刻之后的话单不在库里：按手册「恢复后补推」从服务器 A 的副本补推。'
else
  log "恢复完成：$target"
  log '目标不是生产库：没有改动服务，也没有重设角色密码或安装队列。'
fi
