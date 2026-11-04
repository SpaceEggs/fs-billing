#!/usr/bin/env bash
# 大分区表加索引：父索引 ON ONLY + 逐分区 CREATE INDEX CONCURRENTLY + ATTACH。
# 迁移事务内不能跑 CONCURRENTLY，分区表的父表也不支持直接 CONCURRENTLY，
# 所以按 docs/ops-runbook.md「大表加索引」的步骤拆到事务外执行。
#
#   生产库 fs_billing 必须显式加 --production；其他库名不需要。
#   ops/migrate/concurrent-index.sh --database fs_billing --production \
#     --index cdrs_tenant_started_at --table cdrs --columns 'tenant_id, started_at'
#   ops/migrate/concurrent-index.sh --database <演练库> ... --rollback    先删父索引（连带已挂接分区索引），再删未挂接残留
#   ops/migrate/concurrent-index.sh --database <演练库> ... --dry-run     只打印将执行的 SQL
#
# 连接参数取标准 PG* 环境变量，不写死地址与端口。--database 必填，避免误连到
# PGDATABASE 指向的库。fs_billing 是生产库，必须再加 --production；其他库名
# 不需要这个开关。--inject-failure 在 fs_billing 上一律拒绝，即使加了 --production。
#
# --inject-failure <分区名> 是演练用的测试钩子：先故意建一个会失败的
# concurrently 唯一索引（同名、表达式 ((1))，必然重复），留下 invalid 索引，
# 再走「检测 invalid → DROP INDEX CONCURRENTLY → 重试」的正常路径。只能在
# 非生产库使用。
set -euo pipefail

database=''
table=cdrs
index_name=cdrs_tenant_started_at
columns='tenant_id, started_at'
dry_run=0
rollback=0
production=0
inject_failure=''
machine_label='未标注（调用者应写明是开发机还是服务器 B）'

usage() {
  cat <<'EOF'
用法：concurrent-index.sh --database <库名> [选项]

选项：
  --database <库名>       必填；fs_billing 是生产库，必须同时给 --production
  --production            确认操作 fs_billing；其他库名不需要
  --table <表名>          默认 cdrs
  --index <索引名>        默认 cdrs_tenant_started_at
  --columns <列定义>      默认 "tenant_id, started_at"
  --dry-run               只打印 SQL，不执行
  --rollback              先删父索引（连带已挂接分区索引），再删未挂接残留
  --inject-failure <分区> 演练钩子：先制造同名 invalid 索引，再清理重试
  --machine-label <文字>  证据里的机器说明（开发机 / 服务器 B）
  -h, --help              显示本帮助

连接参数取 PGHOST、PGPORT、PGUSER、PGPASSWORD 等标准环境变量。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

log() {
  printf '%s\n' "$*"
}

while (($# > 0)); do
  case $1 in
    --database)
      [[ $# -ge 2 ]] || fail '--database 需要参数'
      database=$2
      shift 2
      ;;
    --table)
      [[ $# -ge 2 ]] || fail '--table 需要参数'
      table=$2
      shift 2
      ;;
    --index)
      [[ $# -ge 2 ]] || fail '--index 需要参数'
      index_name=$2
      shift 2
      ;;
    --columns)
      [[ $# -ge 2 ]] || fail '--columns 需要参数'
      columns=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --production)
      production=1
      shift
      ;;
    --rollback)
      rollback=1
      shift
      ;;
    --inject-failure)
      [[ $# -ge 2 ]] || fail '--inject-failure 需要参数'
      inject_failure=$2
      shift 2
      ;;
    --machine-label)
      [[ $# -ge 2 ]] || fail '--machine-label 需要参数'
      machine_label=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      fail "未知选项：$1"
      ;;
    *)
      fail "多余参数：$1"
      ;;
  esac
done

[[ -n $database ]] || {
  usage >&2
  fail '必须显式给出 --database'
}
if [[ $database == fs_billing ]]; then
  ((production)) ||
    fail 'fs_billing 是生产库；确实要操作请显式加 --production'
  [[ -z $inject_failure ]] ||
    fail '--inject-failure 在 fs_billing（生产库）上一律拒绝，即使加了 --production'
fi
identifier_pattern='^[a-z_][a-z0-9_]*$'
columns_pattern='^[A-Za-z0-9_ ,()."-]+$'
[[ $table =~ $identifier_pattern ]] || fail "表名不合法：$table"
[[ $index_name =~ $identifier_pattern ]] || fail "索引名不合法：$index_name"
[[ $columns =~ $columns_pattern ]] || fail "列定义不合法：$columns"

command -v psql >/dev/null 2>&1 || fail '找不到命令 psql'

psql_at() {
  psql --dbname="$database" --no-psqlrc --quiet --no-align --tuples-only "$@"
}

run_sql() {
  local statement=$1
  if ((dry_run)); then
    log "  $statement"
    return 0
  fi
  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --command "$statement"
}

# 失败会留下 invalid 索引；先 DROP INDEX CONCURRENTLY 清理，再重试一次。
create_partition_index() {
  local part_name=$1 part_index=$2
  if ((dry_run)); then
    run_sql "CREATE INDEX CONCURRENTLY \"$part_index\" ON \"$part_name\" ($columns);"
    return 0
  fi
  log "  CREATE INDEX CONCURRENTLY $part_index ON $part_name"
  if psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --command "CREATE INDEX CONCURRENTLY \"$part_index\" ON \"$part_name\" ($columns);"; then
    return 0
  fi
  log "  创建 $part_index 失败，检查 invalid 索引并清理后重试"
  if [[ $(psql_at --command "select to_regclass('$part_index') is not null") == t ]]; then
    psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
      --command "DROP INDEX CONCURRENTLY \"$part_index\";"
  fi
  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --command "CREATE INDEX CONCURRENTLY \"$part_index\" ON \"$part_name\" ($columns);"
}

log "# 机器：$machine_label"
log ''

# ---------------------------------------------------------------- 评估

relkind=$(psql_at --command "select relkind from pg_class where oid = to_regclass('$table')")
[[ $relkind == p ]] || fail "$table 不是分区表（relkind=${relkind:-不存在}）"

log '## 1. 评估'
log "表：$table；索引：$index_name；列：$columns"
log ''

log '### 分区与大小'
psql --dbname="$database" --no-psqlrc --quiet --no-align --tuples-only \
  --field-separator=$'\t' --command "
    select c.relname,
      pg_size_pretty(pg_total_relation_size(c.oid)),
      pg_total_relation_size(c.oid)
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    where i.inhparent = '$table'::regclass
    order by c.relname" |
  while IFS=$'\t' read -r partition size bytes; do
    log "  $partition  $size  ($bytes bytes)"
  done

disk_line=''
if data_directory=$(psql_at --command 'select current_setting('"'"'data_directory'"'"')'); then
  if df_line=$(df -Pk "$data_directory" 2>/dev/null | tail -n 1); then
    disk_line=$df_line
  fi
fi
if [[ -n $disk_line ]]; then
  log "磁盘：$data_directory  $disk_line"
else
  log '磁盘：无法从本机读取 data_directory 的余量（跳过；在服务器上应能看到 df 输出）'
fi

maintenance_work_mem=$(psql_at --command 'show maintenance_work_mem')
log "maintenance_work_mem：$maintenance_work_mem"
total_bytes=$(psql_at --command "
  select coalesce(sum(pg_total_relation_size(c.oid)), 0)
  from pg_inherits i join pg_class c on c.oid = i.inhrelid
  where i.inhparent = '$table'::regclass")
log "表总大小：$total_bytes bytes；索引估算约为表的 20%–70%"
log ''

check_long_transactions() {
  local stage=$1 rows
  rows=$(psql_at --field-separator=$'\t' --command "
    select pid, coalesce(application_name, ''), state,
      round(extract(epoch from now() - xact_start))::text,
      left(coalesce(query, ''), 80)
    from pg_stat_activity
    where xact_start is not null
      and now() - xact_start > interval '5 minutes'
      and pid <> pg_backend_pid()
    order by xact_start")
  if [[ -n $rows ]]; then
    log "### 长事务检查（$stage）：发现超过 5 分钟的事务"
    while IFS=$'\t' read -r pid app state seconds query; do
      log "  pid=$pid app=$app state=$state age=${seconds}s query=$query"
    done <<<"$rows"
    fail '存在长事务，CONCURRENTLY 可能无限等待；先处理长事务再重试'
  fi
  log "长事务检查（$stage）：无超过 5 分钟的事务"
}

partitions=()
while IFS= read -r partition; do
  partitions+=("$partition")
done < <(psql_at --command "
  select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
  where i.inhparent = '$table'::regclass order by c.relname")
((${#partitions[@]} > 0)) || fail "$table 没有分区"

parent_exists=$(psql_at --command "select to_regclass('$index_name') is not null")
if [[ $parent_exists == t ]]; then
  parent_valid=$(psql_at --command "select indisvalid from pg_index where indexrelid = to_regclass('$index_name')")
else
  parent_valid=''
fi

# ---------------------------------------------------------------- 回退

if ((rollback)); then
  log '## 回退：先删父索引，再清理未挂接的分区索引'
  # 已挂接的分区索引依赖父索引，PostgreSQL 没有 ALTER INDEX ... DETACH PARTITION；
  # 删父索引会一并删除这些分区索引。未挂接的残留索引再逐个 CONCURRENTLY 删除。
  if [[ $parent_exists == t ]]; then
    # 父索引只能普通 DROP（不能 CONCURRENTLY），会拿表与各分区的 ACCESS EXCLUSIVE；
    # 用 5 秒 lock_timeout 让它拿不到锁就失败，而不是排在长事务后面无限等。
    if ((dry_run)); then
      run_sql "SET lock_timeout = '5s'; DROP INDEX \"$index_name\";"
    else
      log "  SET lock_timeout = '5s'; DROP INDEX $index_name（拿不到锁就失败，避开高峰期）"
      run_sql "SET lock_timeout = '5s'; DROP INDEX \"$index_name\";"
    fi
  else
    log "  跳过不存在的父索引 $index_name"
  fi
  for partition in "${partitions[@]}"; do
    part_name=${partition##*.}
    part_index="${index_name}_${part_name}"
    exists=$(psql_at --command "select to_regclass('$part_index') is not null")
    if [[ $exists == t ]]; then
      if ((dry_run)); then
        run_sql "DROP INDEX CONCURRENTLY \"$part_index\";"
      else
        log "  DROP INDEX CONCURRENTLY $part_index"
        run_sql "DROP INDEX CONCURRENTLY \"$part_index\";"
      fi
    else
      log "  跳过已随父索引删除的 $part_index"
    fi
  done
  log '回退完成'
  exit 0
fi

# ---------------------------------------------------------------- 执行计划

log '## 2–5. 父索引、逐分区 CONCURRENTLY、挂接、验证'

if ((dry_run)); then
  log '将执行：'
fi
if [[ $parent_exists != t ]]; then
  run_sql "CREATE INDEX \"$index_name\" ON ONLY \"$table\" ($columns);"
elif [[ $parent_valid != t ]]; then
  log "父索引 $index_name 已存在但 indisvalid=false，继续挂接"
else
  fail "索引 $index_name 已存在且 valid；要重建请先 --rollback"
fi

injected=0
for partition in "${partitions[@]}"; do
  part_name=${partition##*.}
  part_index="${index_name}_${part_name}"
  if ((${#part_index} > 63)); then
    fail "分区索引名超过 63 字节：$part_index"
  fi

  check_long_transactions "$part_name"

  if ((!dry_run)) && [[ $inject_failure == "$part_name" ]] && ((injected == 0)); then
    injected=1
    log "测试钩子：在 $part_name 上故意制造失败（同名唯一索引 ((1)) 必然重复）"
    set +e
    psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
      --command "CREATE UNIQUE INDEX CONCURRENTLY \"$part_index\" ON \"$part_name\" ((1));"
    status=$?
    set -e
    log "  故意失败退出码：$status（预期非 0，留下 invalid 索引）"
  fi

  exists=$(psql_at --command "select to_regclass('$part_index') is not null")
  if [[ $exists == t ]]; then
    valid=$(psql_at --command "select indisvalid from pg_index where indexrelid = to_regclass('$part_index')")
    if [[ $valid != t ]]; then
      log "  清理 invalid 索引 $part_index"
      run_sql "DROP INDEX CONCURRENTLY \"$part_index\";"
    else
      if [[ $inject_failure == "$part_name" ]] && ((injected)); then
        fail "注入的 $part_index 意外有效（分区是否为空？），换一个有数据的分区"
      fi
      attached=$(psql_at --command "
        select exists (
          select 1 from pg_inherits
          where inhrelid = to_regclass('$part_index')
            and inhparent = to_regclass('$index_name')
        )")
      if [[ $attached == t ]]; then
        log "  跳过已挂接的 $part_index"
        continue
      fi
      log "  $part_index 已存在且 valid，稍后挂接"
      continue
    fi
  fi

  create_partition_index "$part_name" "$part_index" ||
    fail "创建 $part_index 失败；请检查后重跑（脚本会先清理 invalid 索引）"
done

for partition in "${partitions[@]}"; do
  part_name=${partition##*.}
  part_index="${index_name}_${part_name}"
  attached=$(psql_at --command "
    select exists (
      select 1 from pg_inherits
      where inhrelid = to_regclass('$part_index')
        and inhparent = to_regclass('$index_name')
    )")
  if [[ $attached == t ]]; then
    log "  已挂接 $part_index"
  elif ((dry_run)); then
    run_sql "ALTER INDEX \"$index_name\" ATTACH PARTITION \"$part_index\";"
  else
    log "  ATTACH PARTITION $part_index"
    run_sql "ALTER INDEX \"$index_name\" ATTACH PARTITION \"$part_index\";"
  fi
done

# ---------------------------------------------------------------- 验证

log ''
log '## 6. 验证'
if ((dry_run)); then
  log '  （dry-run 不执行验证查询）'
  log '  将检查 pg_index.indisvalid、EXPLAIN 与 pg_stat_user_indexes'
  exit 0
fi

parent_valid=$(psql_at --command "select indisvalid from pg_index where indexrelid = to_regclass('$index_name')")
log "父索引 indisvalid：$parent_valid"
[[ $parent_valid == t ]] || fail '父索引仍为 invalid'

invalid_children=$(psql_at --command "
  select count(*) from pg_index
  where indexrelid::regclass::text like '${index_name}_%' and not indisvalid")
log "invalid 分区索引数：$invalid_children"
[[ $invalid_children == 0 ]] || fail '仍有 invalid 分区索引'

log '各分区索引状态：'
psql --dbname="$database" --no-psqlrc --quiet --no-align --tuples-only \
  --field-separator=$'\t' --command "
    select c.relname, i.indisvalid
    from pg_index i join pg_class c on c.oid = i.indexrelid
    where c.relname like '${index_name}_%'
    order by c.relname" |
  while IFS=$'\t' read -r name valid; do
    log "  $name indisvalid=$valid"
  done

first_column=${columns%%,*}
first_column=$(printf '%s' "$first_column" | xargs)
explain_query="select $columns from $table where $first_column = (select $first_column from $table limit 1) order by $columns limit 10"
log ''
log 'EXPLAIN（关闭 seqscan 以强制规划器考虑索引）：'
log "  $explain_query"
explain_output=$(psql --dbname="$database" --no-psqlrc --quiet --no-align --tuples-only \
  --command "set enable_seqscan = off; explain (costs off) $explain_query;")
printf '%s\n' "$explain_output"
if [[ $explain_output != *"$index_name"* ]]; then
  fail 'EXPLAIN 没有使用新索引'
fi

log ''
log '实际执行一次查询并刷新统计，然后读 pg_stat_user_indexes：'
psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
  --command "set enable_seqscan = off; $explain_query;" >/dev/null
psql --dbname="$database" --no-psqlrc --quiet --command 'select pg_stat_force_next_flush();' >/dev/null
sleep 1
psql --dbname="$database" --no-psqlrc --quiet --no-align --tuples-only \
  --field-separator=$'\t' --command "
    select indexrelname, idx_scan, idx_tup_read
    from pg_stat_user_indexes
    where indexrelname like '${index_name}_%'
    order by indexrelname" |
  while IFS=$'\t' read -r name scans tuples; do
    log "  $name idx_scan=$scans idx_tup_read=$tuples"
  done

log ''
log '完成。回退：同一脚本加 --rollback。'
