#!/usr/bin/env bash
# 每周恢复演练（阶段 10 验收 3）。校验最新一套备份的 sha256，再让 restore.sh --verify
# 恢复到临时库、核对行数（含分区）与账本不变量，最后删除临时库。全程不碰生产库。
#
#   ops/backup/verify-restore.sh [--dump <文件>] [--config <文件>]
#
# 由 fs-billing-backup-verify.timer 每周调用；失败退出非零，systemd 记为失败。
set -euo pipefail
umask 077

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config_file=/etc/fs-billing/backup.conf
dump=''

usage() {
  cat <<'EOF'
用法：verify-restore.sh [--dump <文件>] [--config <文件>]

不带 --dump 时取 BACKUP_DIR 里文件名最新的 fs_billing-*.dump，先按同一套的
SHA256SUMS-<时间> 校验所有产物，再调用 restore.sh --verify 核对。
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
    --dump)
      (($# >= 2)) || fail '--dump 需要文件路径'
      dump=$2
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

BACKUP_DIR=${BACKUP_DIR:-/root/backups}
OWNER_ENV_FILE=${OWNER_ENV_FILE:-/etc/fs-billing/owner.env}

command -v sha256sum >/dev/null 2>&1 || fail '缺少命令：sha256sum'
[[ -r $OWNER_ENV_FILE ]] || fail "读不到 owner 环境文件：$OWNER_ENV_FILE"

if [[ -z $dump ]]; then
  dump_name=$(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name 'fs_billing-*.dump' -printf '%f\n' |
      sort | tail -n 1
  )
  [[ -n $dump_name ]] || fail "在 $BACKUP_DIR 里找不到 fs_billing-*.dump"
  dump=$BACKUP_DIR/$dump_name
fi
[[ -r $dump ]] || fail "读不到备份文件：$dump"

dump_name=${dump##*/}
stamp=${dump_name#fs_billing-}
stamp=${stamp%.dump}
[[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "备份文件名里没有可识别的时间戳：$dump"

sums=$BACKUP_DIR/SHA256SUMS-$stamp
[[ -r $sums ]] || fail "找不到校验和文件：$sums"
grep -qF "  $dump_name" "$sums" || fail "$sums 里没有 $dump_name"

log "校验备份 $stamp 的 sha256"
(
  cd "$BACKUP_DIR" || fail "进不去 $BACKUP_DIR"
  sha256sum --check --quiet "$sums"
)
log '校验和一致'

# 校验和只证明字节没变；再确认两个 tar 包能完整读出（不解包、不覆盖任何目录）。
for artifact in "$BACKUP_DIR/archive-$stamp.tar.gz" "$BACKUP_DIR/config-$stamp.tar.gz"; do
  [[ -r $artifact ]] || fail "找不到 $artifact"
  tar --list --gzip --file="$artifact" >/dev/null ||
    fail "归档包解不开：$artifact"
done
log '归档包可读'

"$script_dir/restore.sh" --verify --dump "$dump" --config "$config_file"
log "每周恢复演练通过：$dump"
