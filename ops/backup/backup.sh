#!/usr/bin/env bash
# 每日备份（阶段 10 验收 3）。顺序固定为：数据库 → 角色 → 归档目录 → 配置。
# 每个产物先写 .partial，校验通过后才改名；最后写 SHA256SUMS 与 LATEST.json。
#
#   ops/backup/backup.sh [--config /etc/fs-billing/backup.conf]
#
# 数据库与角色用 owner 连接（连接串从 owner.env 读取，只进环境变量，不进命令行和日志）。
# 备份里有完整号码与客户资料：目录 700、文件 600。异地目标见 offsite/README.md；
# 未配置时只存本机，这是已知差距，见 docs/ops-runbook.md「备份」。
set -euo pipefail
umask 077

config_file=/etc/fs-billing/backup.conf

usage() {
  cat <<'EOF'
用法：backup.sh [--config <文件>]

  --config  备份配置，默认 /etc/fs-billing/backup.conf（示例见 backup.conf.example）

依次备份数据库（pg_dump -Fc）、角色（pg_dumpall --globals-only）、归档目录与配置，
写 SHA256SUMS 与 LATEST.json，然后按配置清理过期备份、调用可选的异地驱动。
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

[[ $EUID -eq 0 ]] || fail '必须以 root 执行：备份目录与 owner.env 只允许 root'
[[ -r $config_file ]] || fail "读不到配置文件：$config_file（示例见 backup.conf.example）"

# shellcheck source=/dev/null
. "$config_file"

BACKUP_DIR=${BACKUP_DIR:-/root/backups}
ARCHIVE_DIR=${ARCHIVE_DIR:-/var/lib/fs-billing/archive}
RETENTION_DAYS=${RETENTION_DAYS:-30}
MIN_KEEP=${MIN_KEEP:-3}
OWNER_ENV_FILE=${OWNER_ENV_FILE:-/etc/fs-billing/owner.env}
OFFSITE_COMMAND=${OFFSITE_COMMAND:-}

config_paths=()
# shellcheck disable=SC2153 # CONFIG_PATHS 来自 backup.conf，不是本脚本里的 config_paths
if declare -p CONFIG_PATHS >/dev/null 2>&1; then
  config_paths=("${CONFIG_PATHS[@]}")
fi
if ((${#config_paths[@]} == 0)); then
  config_paths=(/etc/fs-billing /etc/nginx/conf.d /etc/ssl/fs-billing)
fi

for command in pg_dump pg_dumpall pg_restore psql tar sha256sum df find sort awk date stat; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command（Debian 包 postgresql-client-17）"
done

[[ -r $OWNER_ENV_FILE ]] || fail "读不到 owner 环境文件：$OWNER_ENV_FILE"
# shellcheck source=/dev/null
. "$OWNER_ENV_FILE"
[[ -n ${DATABASE_URL:-} ]] || fail "owner 环境文件里没有 DATABASE_URL：$OWNER_ENV_FILE"

# 把 DATABASE_URL 拆成 PG* 环境变量：连接串只进环境，密码不进命令行与日志。
# 支持的写法就是仓库 env 示例里的 postgresql://用户:密码@主机:端口/库名（可带 ?sslmode=）。
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

  # 百分号编码（密码里的 @ : / 等）还原；没有 % 时原样输出。
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
db_name=$PGDATABASE
[[ $db_name =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || fail "DATABASE_URL 里的库名不合法：$db_name"
export PGAPPNAME=fs-billing-backup

[[ -d $ARCHIVE_DIR ]] || fail "归档目录不存在：$ARCHIVE_DIR（确认 RAW_CDR_ARCHIVE_DIR，不要跳过）"
[[ -d $ARCHIVE_DIR && -r $ARCHIVE_DIR ]] || fail "归档目录不可读：$ARCHIVE_DIR"

install -d -m 0700 "$BACKUP_DIR"
if [[ $(stat -c %a "$BACKUP_DIR") != 700 ]]; then
  chmod 0700 "$BACKUP_DIR"
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
hostname=$(uname -n)
db_dump=fs_billing-$stamp.dump
globals_dump=globals-$stamp.sql
archive_tar=archive-$stamp.tar.gz
config_tar=config-$stamp.tar.gz
sums_file=SHA256SUMS-$stamp

stamp_epoch() {
  local value=$1
  [[ $value =~ ^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$ ]] || return 1
  date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}Z" +%s
}

latest_dump_name() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%f\n' | sort | tail -n 1
}

# 磁盘不足先失败：剩余空间小于上次库备份的 2 倍就退出。
check_disk_space() {
  local previous available required
  previous=$(latest_dump_name)
  ((${#previous} > 0)) || return 0
  required=$(( $(stat -c %s "$BACKUP_DIR/$previous") * 2 ))
  available=$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 * 1024 }')
  [[ $available =~ ^[0-9]+$ ]] || fail "读不到 $BACKUP_DIR 的剩余空间"
  if ((available < required)); then
    fail "磁盘空间不足：需要约 $((required / 1024 / 1024)) MiB，剩余 $((available / 1024 / 1024)) MiB"
  fi
}

file_bytes() {
  stat -c %s "$1"
}

file_sha256() {
  sha256sum "$1" | awk '{ print $1 }'
}

# ---- 1. 数据库 ----
check_disk_space
log "备份数据库 $db_name"

# 任何一步失败都只留下 .partial：它们不参与保留策略，也不会被当成一套完整备份。
trap 'rm -f -- "$BACKUP_DIR"/*.partial' EXIT

dump_partial=$BACKUP_DIR/$db_dump.partial
toc_partial=$BACKUP_DIR/$db_dump.toc.partial

pg_dump --format=custom --no-password --file="$dump_partial"

toc_entries=$(pg_restore --list "$dump_partial" | grep -cE '^[0-9]+;' || true)
((toc_entries > 0)) || fail 'pg_restore --list 没有条目：备份不完整'
pg_restore --list "$dump_partial" >"$toc_partial"

chmod 0600 "$dump_partial"
mv -- "$dump_partial" "$BACKUP_DIR/$db_dump"
rm -f -- "$toc_partial"
log "  库备份 $db_dump（$toc_entries 个条目）"

# ---- 2. 角色 ----
# pg_dump -Fc 不含角色；RLS 策略、SECURITY DEFINER 函数属主依赖它们，恢复到新机器需要。
log '备份角色（含密码哈希）'
globals_partial=$BACKUP_DIR/$globals_dump.partial
pg_dumpall --globals-only --no-password --file="$globals_partial"
[[ -s $globals_partial ]] || {
  rm -f -- "$globals_partial"
  fail '角色备份为空：pg_dumpall --globals-only 没有输出'
}
chmod 0600 "$globals_partial"
mv -- "$globals_partial" "$BACKUP_DIR/$globals_dump"
log "  角色备份 $globals_dump"

# ---- 3. 归档目录 ----
# 放在库之后：库里的清单引用的文件在打库时都已存在，晚拍的目录是早拍的库的超集。
log "备份原始话单归档目录 $ARCHIVE_DIR"
archive_partial=$BACKUP_DIR/$archive_tar.partial
tar --create --gzip --file="$archive_partial" --directory="$ARCHIVE_DIR" .
chmod 0600 "$archive_partial"
mv -- "$archive_partial" "$BACKUP_DIR/$archive_tar"

archive_files=$(find "$ARCHIVE_DIR" -type f -printf '.' | wc -c)
archive_bytes=$(find "$ARCHIVE_DIR" -type f -printf '%s\n' | awk '{ sum += $1 } END { print sum + 0 }')
log "  归档 $archive_tar（$archive_files 个文件，$archive_bytes 字节）"

# ---- 4. 配置 ----
existing_config_paths=()
for path in "${config_paths[@]}"; do
  [[ -e $path ]] && existing_config_paths+=("$path")
done
((${#existing_config_paths[@]} > 0)) ||
  fail "配置路径都不存在：${config_paths[*]}（检查 CONFIG_PATHS）"

log '备份配置与证书私钥（含秘密，异地时必须加密）'
config_partial=$BACKUP_DIR/$config_tar.partial
tar --create --gzip --absolute-names --file="$config_partial" "${existing_config_paths[@]}"
chmod 0600 "$config_partial"
mv -- "$config_partial" "$BACKUP_DIR/$config_tar"
log "  配置 $config_tar（${existing_config_paths[*]}）"

# ---- 5. 校验和 ----
log '写校验和'
for artifact in "$db_dump" "$globals_dump" "$archive_tar" "$config_tar"; do
  chmod 0600 "$BACKUP_DIR/$artifact"
done
(
  cd "$BACKUP_DIR"
  sha256sum "$db_dump" "$globals_dump" "$archive_tar" "$config_tar" >"$sums_file.partial"
)
chmod 0600 "$BACKUP_DIR/$sums_file.partial"
mv -- "$BACKUP_DIR/$sums_file.partial" "$BACKUP_DIR/$sums_file"

# ---- 6. LATEST.json ----
dump_bytes=$(file_bytes "$BACKUP_DIR/$db_dump")
dump_sha=$(file_sha256 "$BACKUP_DIR/$db_dump")
globals_bytes=$(file_bytes "$BACKUP_DIR/$globals_dump")
globals_sha=$(file_sha256 "$BACKUP_DIR/$globals_dump")
archive_size=$(file_bytes "$BACKUP_DIR/$archive_tar")
archive_sha=$(file_sha256 "$BACKUP_DIR/$archive_tar")
config_size=$(file_bytes "$BACKUP_DIR/$config_tar")
config_sha=$(file_sha256 "$BACKUP_DIR/$config_tar")
total_bytes=$((dump_bytes + globals_bytes + archive_size + config_size))

latest_partial=$BACKUP_DIR/LATEST.json.partial
{
  printf '{\n'
  printf '  "createdAt": "%s",\n' "$created_at"
  printf '  "hostname": "%s",\n' "$hostname"
  printf '  "database": "%s",\n' "$db_name"
  printf '  "dump": { "file": "%s", "bytes": %s, "sha256": "%s", "tocEntries": %s },\n' \
    "$db_dump" "$dump_bytes" "$dump_sha" "$toc_entries"
  printf '  "globals": { "file": "%s", "bytes": %s, "sha256": "%s" },\n' \
    "$globals_dump" "$globals_bytes" "$globals_sha"
  printf '  "archive": { "file": "%s", "bytes": %s, "sha256": "%s", "files": %s, "contentBytes": %s },\n' \
    "$archive_tar" "$archive_size" "$archive_sha" "$archive_files" "$archive_bytes"
  printf '  "config": { "file": "%s", "bytes": %s, "sha256": "%s" },\n' \
    "$config_tar" "$config_size" "$config_sha"
  printf '  "totalBytes": %s\n' "$total_bytes"
  printf '}\n'
} >"$latest_partial"
chmod 0600 "$latest_partial"
mv -- "$latest_partial" "$BACKUP_DIR/LATEST.json"
log "写 LATEST.json（共 $total_bytes 字节）"

# ---- 7. 异地（可选） ----
offsite_status=skipped
if [[ -n $OFFSITE_COMMAND ]]; then
  read -r -a offsite_cmd <<<"$OFFSITE_COMMAND"
  if ((${#offsite_cmd[@]} == 0)); then
    fail 'OFFSITE_COMMAND 为空字符串或无效'
  fi
  offsite_status=ok
  for artifact in "$db_dump" "$globals_dump" "$archive_tar" "$config_tar" "$sums_file"; do
    log "异地：提交 $artifact"
    if ! "${offsite_cmd[@]}" "$BACKUP_DIR/$artifact"; then
      log "异地：失败 $artifact"
      offsite_status=failed
    fi
  done
fi

# ---- 8. 保留策略 ----
# 按文件名里的 UTC 时间戳（不信 mtime）删除整套备份，且至少保留最近 MIN_KEEP 套。
prune_sets() {
  local -a stamps=()
  local stamp epoch now age index total
  mapfile -t stamps < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%f\n' |
      sed 's/^fs_billing-//; s/\.dump$//' | sort
  )
  total=${#stamps[@]}
  now=$(date -u +%s)
  for index in "${!stamps[@]}"; do
    stamp=${stamps[$index]}
    epoch=$(stamp_epoch "$stamp") || continue
    age=$(((now - epoch) / 86400))
    ((age > RETENTION_DAYS)) || continue
    # 从本套到最新共 total - index 套；删掉本套后只剩 total - index - 1 套，
    # 少于 MIN_KEEP 就停手（等号会多删一套，留下 MIN_KEEP - 1 套）。
    ((total - index - 1 >= MIN_KEEP)) || continue
    for artifact in \
      "fs_billing-$stamp.dump" \
      "globals-$stamp.sql" \
      "archive-$stamp.tar.gz" \
      "config-$stamp.tar.gz" \
      "SHA256SUMS-$stamp"; do
      if [[ -e $BACKUP_DIR/$artifact ]]; then
        rm -f -- "$BACKUP_DIR/$artifact"
        log "删除过期备份：$artifact"
      fi
    done
  done
}

prune_sets

log "备份完成：$stamp，异地状态：$offsite_status"
[[ $offsite_status != failed ]] || exit 1
