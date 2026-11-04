#!/usr/bin/env bash
# 在有历史数据的库上演练迁移：逐文件计时、采样迁移事务持有的锁、同时跑写入探针。
#
#   ops/migrate/rehearse.sh [选项] <数据来源> <目标迁移号>
#
# 数据来源：
#   /path/to/backup.dump   pg_dump -Fc 备份，恢复到临时库
#   db:<数据库名>          同一实例上的库，用 CREATE DATABASE ... TEMPLATE 复制
#   prototype:<迁移号>     建原型数据（默认 300 万条话单），先静默迁到该号再灌数据
#   empty                  空库，从 0000 开始
#
# 目标迁移号写 0004 或完整 tag。临时库默认叫 fs_billing_rehearse，结束时删除；
# 脚本拒绝把 fs_billing 当源库或目标库。连接参数取标准 PG* 环境变量
# （PGHOST、PGPORT、PGUSER、PGPASSWORD 等），不写死地址与端口。
#
# 输出（--out 目录）：
#   summary.md         每文件墙钟耗时、最强锁与持锁时长、探针统计、部署窗口估算
#   lock-timeline.txt  迁移事务的 pg_locks 采样
#   probe-latency.txt  每 50ms 一次 cdrs 写入探测（插入后回滚）的延迟
#
# --batch 按真实 drizzle migrator 的方式，把本轮所有待执行迁移放在同一个事务里
# 执行；此时 summary.md 只报告整批的总墙钟、最强锁及其跨度、探针最大与受阻时间。
#
# 注意：原型数据里的号码是合成号码，不对应真实用户。
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)
migrations_dir=$repo_root/packages/db/migrations
journal=$migrations_dir/meta/_journal.json

maintenance_db=${PGMAINTENANCE_DB:-postgres}
database=fs_billing_rehearse
cdrs_rows=3000000
keep=0
batch=0
out_dir=''
machine_label='未标注（调用者应写明是开发机还是服务器 B）'
source_arg=''
target_arg=''

usage() {
  cat <<'EOF'
用法：rehearse.sh [选项] <数据来源> <目标迁移号>

数据来源：
  /path/to/backup.dump   pg_dump -Fc 备份
  db:<数据库名>          同一实例上的库（模板复制）
  prototype:<迁移号>     生成原型数据后从该迁移号继续（默认 300 万条）
  empty                  空库

选项：
  --database <名字>      临时库名（默认 fs_billing_rehearse）
  --cdrs <行数>          prototype 的话单行数（默认 3000000）
  --batch                与真实 migrator 一致：本轮待执行迁移放在一个事务里
  --keep                 演练结束保留临时库
  --out <目录>           写出 summary.md、lock-timeline.txt、probe-latency.txt
  --machine-label <文字> summary.md 里的机器说明（开发机 / 服务器 B）
  -h, --help             显示本帮助

连接参数取 PGHOST、PGPORT、PGUSER、PGPASSWORD 等标准环境变量。
脚本拒绝源库或目标库名为 fs_billing。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case $1 in
    --database)
      [[ $# -ge 2 ]] || fail '--database 需要参数'
      database=$2
      shift 2
      ;;
    --cdrs)
      [[ $# -ge 2 ]] || fail '--cdrs 需要参数'
      cdrs_rows=$2
      shift 2
      ;;
    --batch)
      batch=1
      shift
      ;;
    --keep)
      keep=1
      shift
      ;;
    --out)
      [[ $# -ge 2 ]] || fail '--out 需要参数'
      out_dir=$2
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
      if [[ -z $source_arg ]]; then
        source_arg=$1
      elif [[ -z $target_arg ]]; then
        target_arg=$1
      else
        fail "多余参数：$1"
      fi
      shift
      ;;
  esac
done

[[ -n $source_arg ]] || {
  usage >&2
  fail '缺少数据来源'
}
[[ -n $target_arg ]] || {
  usage >&2
  fail '缺少目标迁移号'
}
[[ $cdrs_rows =~ ^[0-9]+$ ]] || fail '--cdrs 必须是正整数'
[[ $database != fs_billing ]] || fail '拒绝在 fs_billing 上演练：临时库必须是独立的库'

for command in psql createdb dropdb jq; do
  command -v "$command" >/dev/null 2>&1 || fail "找不到命令 $command"
done
if [[ $source_arg == /* && ! -f $source_arg ]]; then
  fail "备份文件不存在：$source_arg"
fi

now_ms() {
  # perl 在 Debian 与 macOS 都随系统提供；date +%s%N 在 macOS 的 BSD date 上不可靠。
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
}

sha256_file() {
  openssl dgst -sha256 "$1" | awk '{ print $NF }'
}

sql_psql() {
  psql --no-psqlrc --quiet --no-align --tuples-only "$@"
}

drop_database() {
  dropdb --if-exists --force --maintenance-db="$maintenance_db" "$@" >/dev/null
}

create_database() {
  createdb --maintenance-db="$maintenance_db" "$@"
}

# journal: idx \t tag \t when
mapfile -t journal_rows < <(
  jq -r '.entries[] | "\(.idx)\t\(.tag)\t\(.when)"' "$journal"
)
((${#journal_rows[@]} > 0)) || fail "读不到迁移 journal：$journal"

find_entry() {
  local wanted=$1 row idx tag when
  for row in "${journal_rows[@]}"; do
    IFS=$'\t' read -r idx tag when <<<"$row"
    if [[ $tag == "$wanted" || $tag == "$wanted"_* ]]; then
      printf '%s\t%s\t%s\n' "$idx" "$tag" "$when"
      return 0
    fi
  done
  return 1
}

target_entry=$(find_entry "$target_arg") || fail "找不到目标迁移：$target_arg"
IFS=$'\t' read -r target_idx target_tag _ <<<"$target_entry"

for row in "${journal_rows[@]}"; do
  IFS=$'\t' read -r idx tag when <<<"$row"
  file=$migrations_dir/$tag.sql
  [[ -f $file ]] || fail "迁移文件不存在：$file"
done

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/fsb-rehearse.XXXXXX")
timings_file=$work_dir/timings.tsv
locks_file=$work_dir/locks.tsv
psql_log=$work_dir/psql.log
cleanup() {
  stop_watchers
  rm -rf -- "$work_dir"
}
probe_pid=''
sampler_pid=''

stop_watchers() {
  if [[ -n $probe_pid || -n $sampler_pid ]]; then
    # 让 \watch 会话自己退出：docker exec / 远程 psql 不一定把宿主机的 kill 转发到后端。
    sql_psql --dbname="$database" \
      --command 'insert into rehearse_stop values (true)' >/dev/null 2>&1 || true
    sleep 1
  fi
  if [[ -n $probe_pid ]]; then
    kill "$probe_pid" 2>/dev/null || true
    wait "$probe_pid" 2>/dev/null || true
    probe_pid=''
  fi
  if [[ -n $sampler_pid ]]; then
    kill "$sampler_pid" 2>/dev/null || true
    wait "$sampler_pid" 2>/dev/null || true
    sampler_pid=''
  fi
}
trap cleanup EXIT

start_watch() {
  local interval=$1 statement=$2 app_name=$3
  {
    printf '%s\n' '\pset tuples_only on' '\pset format unaligned'
    printf '%s\n' "$statement"
    printf '\\watch %s\n' "$interval"
  } | PGAPPNAME="$app_name" psql --dbname="$database" --no-psqlrc --quiet \
    >/dev/null 2>&1 &
  printf '%s\n' "$!"
}

current_tag() {
  sql_psql --dbname="$database" \
    --command "update rehearse_current set tag = '$1'" >/dev/null
}

# 先在临时库里建 drizzle 的迁移记录表；真实 migrator 也会先建它。
prepare_migration_table() {
  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --command "create schema if not exists drizzle" \
    --command "create table if not exists drizzle.__drizzle_migrations (
      id serial primary key, hash text not null, created_at bigint)" \
    >/dev/null
}

# apply_migration <idx> <tag> <when> <measured>
apply_migration() {
  local idx=$1 tag=$2 when=$3 measured=$4
  local file=$migrations_dir/$tag.sql
  local hash temp_sql start_ms end_ms status ms

  hash=$(sha256_file "$file")
  temp_sql=$(mktemp "${TMPDIR:-/tmp}/fsb-migrate.XXXXXX")
  cat -- "$file" >"$temp_sql"
  printf "\ninsert into drizzle.__drizzle_migrations (hash, created_at) values ('%s', %s);\n" \
    "$hash" "$when" >>"$temp_sql"

  if ((measured)); then
    current_tag "$tag"
    start_ms=$(now_ms)
  fi

  set +e
  PGAPPNAME=fsb-rehearse-migration psql --dbname="$database" --no-psqlrc \
    --quiet --set=ON_ERROR_STOP=1 --single-transaction --file="$temp_sql" \
    >>"$psql_log" 2>&1
  status=$?
  set -e

  if ((measured)); then
    end_ms=$(now_ms)
    ms=$((end_ms - start_ms))
    printf '%s\t%s\t%s\n' "$tag" "$ms" "$idx" >>"$timings_file"
    current_tag ''
  fi

  rm -f -- "$temp_sql"
  if ((status != 0)); then
    printf '迁移失败：%s\n' "$tag" >&2
    tail -n 40 "$psql_log" >&2 || true
    fail "迁移 $tag 失败；临时库保留供检查（若未 --keep 请手动 dropdb $database）"
  fi
  printf '迁移 %s 完成%s\n' "$tag" "$(
    if ((measured)); then printf '（%s ms）' "$ms"; fi
  )" >&2
}

# 真实 migrator 把所有待执行迁移放在同一个事务里；--batch 照此执行，
# 用来测量一次部署有多个待执行迁移时锁被持有多久。
apply_batch() {
  local baseline_idx=$1 target_idx=$2
  local idx tag when file hash temp_sql start_ms end_ms status ms first_tag=''
  temp_sql=$(mktemp "${TMPDIR:-/tmp}/fsb-migrate-batch.XXXXXX")
  : >"$temp_sql"
  for ((idx = baseline_idx + 1; idx <= target_idx; idx++)); do
    IFS=$'\t' read -r _ tag when <<<"${journal_rows[$idx]}"
    if [[ -z $first_tag ]]; then first_tag=$tag; fi
    file=$migrations_dir/$tag.sql
    hash=$(sha256_file "$file")
    {
      cat -- "$file"
      printf '\n'
      printf "insert into drizzle.__drizzle_migrations (hash, created_at) values ('%s', %s);\n" \
        "$hash" "$when"
    } >>"$temp_sql"
  done

  current_tag 'batch'
  start_ms=$(now_ms)
  set +e
  PGAPPNAME=fsb-rehearse-migration psql --dbname="$database" --no-psqlrc \
    --quiet --set=ON_ERROR_STOP=1 --single-transaction --file="$temp_sql" \
    >>"$psql_log" 2>&1
  status=$?
  set -e
  end_ms=$(now_ms)
  ms=$((end_ms - start_ms))
  current_tag ''
  printf 'batch\t%s\t%s\n' "$ms" "$baseline_idx" >>"$timings_file"

  rm -f -- "$temp_sql"
  if ((status != 0)); then
    printf '批次迁移失败：%s -> %s\n' "$first_tag" "$target_tag" >&2
    tail -n 40 "$psql_log" >&2 || true
    fail "批次迁移失败；临时库保留供检查（若未 --keep 请手动 dropdb $database）"
  fi
  printf '批次迁移 %s -> %s 完成（%s ms）\n' "$first_tag" "$target_tag" "$ms" >&2
}

seed_prototype() {
  local baseline_idx=$1
  local tenant_id='00000000-0000-4000-8000-0000000000aa'
  local billing_col='' billing_val=''
  local first last chunk=100000
  if ((baseline_idx >= 3)); then
    billing_col=', billing_number'
    billing_val=', c.prefix || t.national'
  fi

  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 >/dev/null <<SQL
select set_config('app.scope', 'system', false);
insert into tenants (id, code, name, currency, overdraft_limit)
values ('$tenant_id', 'REHEARSE', '迁移演练原型', 'CNY', 1000)
on conflict (id) do nothing;
select count(*) from cdr_ensure_partitions(date_trunc('month', now()) - interval '13 months', 14);
SQL

  printf '生成原型数据：%s 条 cdrs\n' "$cdrs_rows" >&2
  for ((first = 1; first <= cdrs_rows; first += chunk)); do
    last=$((first + chunk - 1))
    if ((last > cdrs_rows)); then last=$cdrs_rows; fi
    psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
      -v first="$first" -v last="$last" <<SQL
begin;
set local synchronous_commit = off;
insert into cdrs (
  tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
  matched_prefix, country, rate, charge, duration_seconds, billed_minutes,
  hangup_cause, unverified$billing_col
)
select
  '$tenant_id'::uuid,
  md5('$tenant_id:' || i::text)::uuid,
  t.started,
  case when t.answered then t.started + interval '5 seconds' end,
  t.started + case when t.answered
    then interval '5 seconds' + make_interval(secs => t.dur)
    else interval '30 seconds' end,
  '861' || lpad((i::bigint * 7919 % 1000000000)::text, 9, '0'),
  c.prefix || t.national,
  case when t.answered then c.prefix end,
  case when t.answered then c.name end,
  case when t.answered then c.rate end,
  case when t.answered then ceil(t.dur / 60.0) * c.rate else 0 end,
  case when t.answered then t.dur else 0 end,
  case when t.answered then ceil(t.dur / 60.0) else 0 end,
  case when t.answered then 'NORMAL_CLEARING' else 'NO_ANSWER' end,
  false$billing_val
from generate_series(:first, :last) i
cross join lateral (
  select
    date_trunc('month', now()) - interval '13 months'
      + (interval '14 months') * ((i - 1)::float8 / $cdrs_rows) as started,
    (i % 100) < 95 as answered,
    1 + (i % 300) as dur,
    lpad((i::bigint * 104729 % 1000000000)::text, 9, '0') as national
) t
cross join lateral (
  select prefix, name, rate
  from (values
    ('86', '中国', 0.0500::numeric),
    ('1', '美国/加拿大', 0.0100::numeric),
    ('44', '英国', 0.0200::numeric),
    ('81', '日本', 0.0350::numeric)
  ) v(prefix, name, rate)
  offset (i % 4) limit 1
) c;
commit;
SQL
    printf '  %s / %s\n' "$last" "$cdrs_rows" >&2
  done

  printf 'VACUUM ANALYZE cdrs（原型数据）...\n' >&2
  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
    --command 'vacuum (analyze) cdrs' >/dev/null
}

prepare_probe() {
  # --batch 时先把租户固定到一张探针专用表：迁移可能在整批里先锁 cdrs、再锁
  # tenants，如果探针每个事务都读 tenants 再写 cdrs，就会和迁移成环。首次
  # --batch 运行正是这样死锁的（见 migration-rehearsal/batch/summary.md 的
  # 「首次运行死锁」）。缓存后探针不再读 tenants，所以这一轮不会复现该竞争，
  # 也就测不到它；真实业务写入仍是读 tenants 再写 cdrs。默认模式保持原样，
  # 每个探针事务仍从 tenants 取租户。
  if ((batch)); then
    psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<'SQL'
create table if not exists rehearse_probe_context (tenant_id uuid);
truncate rehearse_probe_context;
insert into rehearse_probe_context (tenant_id)
  select id from tenants order by id limit 1;
SQL
  else
    psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 \
      --command 'drop table if exists rehearse_probe_context' >/dev/null
  fi

  psql --dbname="$database" --no-psqlrc --quiet --set=ON_ERROR_STOP=1 <<'SQL'
create table if not exists rehearse_current (tag text);
truncate rehearse_current;
insert into rehearse_current values ('');
create table if not exists rehearse_stop (stop boolean);
truncate rehearse_stop;
create table if not exists rehearse_probe_samples (
  sampled_at timestamptz not null,
  latency_ms numeric not null,
  ok boolean not null,
  error text
);
truncate rehearse_probe_samples;
create table if not exists rehearse_lock_samples (
  sampled_at timestamptz not null,
  tag text,
  pid integer,
  locktype text,
  relation text,
  mode text,
  granted boolean
);
truncate rehearse_lock_samples;

create or replace function rehearse_probe() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tenant uuid;
  v_started timestamptz := clock_timestamp();
  v_ok boolean := true;
  v_error text := '';
  v_has_billing boolean;
begin
  perform set_config('lock_timeout', '60s', true);
  perform set_config('statement_timeout', '120s', true);
  if to_regclass('rehearse_probe_context') is not null then
    select tenant_id into v_tenant from rehearse_probe_context limit 1;
  else
    select id into v_tenant from tenants order by id limit 1;
  end if;
  if v_tenant is null then
    insert into rehearse_probe_samples values (v_started, 0, false, '没有租户可写');
    return;
  end if;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cdrs'
      and column_name = 'billing_number'
  ) into v_has_billing;
  begin
    if v_has_billing then
      insert into cdrs (
        tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
        matched_prefix, country, rate, charge, duration_seconds, billed_minutes,
        hangup_cause, unverified, billing_number
      ) values (
        v_tenant, gen_random_uuid(), v_started, v_started + interval '1 second',
        v_started + interval '2 seconds', '8613800000000', '8613800000000',
        '86', '中国', 0.0500, 0.0500, 1, 1, 'NORMAL_CLEARING', false,
        '8613800000000'
      );
    else
      insert into cdrs (
        tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
        matched_prefix, country, rate, charge, duration_seconds, billed_minutes,
        hangup_cause, unverified
      ) values (
        v_tenant, gen_random_uuid(), v_started, v_started + interval '1 second',
        v_started + interval '2 seconds', '8613800000000', '8613800000000',
        '86', '中国', 0.0500, 0.0500, 1, 1, 'NORMAL_CLEARING', false
      );
    end if;
    -- 插入成功后主动回滚，探针不改变数据。
    raise exception 'rehearse probe rollback' using errcode = 'P0001';
  exception
    when sqlstate 'P0001' then
      v_ok := true;
    when others then
      v_ok := false;
      v_error := sqlstate || ':' || sqlerrm;
  end;
  insert into rehearse_probe_samples
  values (
    v_started,
    round(extract(epoch from clock_timestamp() - v_started) * 1000, 3),
    v_ok,
    nullif(v_error, '')
  );
  perform pg_sleep(0.05);
end $$;

create or replace function rehearse_sample_locks() returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into rehearse_lock_samples
  select clock_timestamp(),
    (select tag from rehearse_current limit 1),
    l.pid,
    l.locktype,
    coalesce(l.relation::regclass::text, ''),
    l.mode,
    l.granted
  from pg_locks l
  join pg_stat_activity a on a.pid = l.pid
  where a.application_name = 'fsb-rehearse-migration'
$$;

-- \watch 每轮调用一次；停止表有行时让会话自己断开，避免依赖宿主机 kill 转发。
create or replace function rehearse_watch_probe() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from rehearse_stop) then
    perform pg_terminate_backend(pg_backend_pid());
  else
    perform rehearse_probe();
  end if;
end $$;

create or replace function rehearse_watch_locks() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from rehearse_stop) then
    perform pg_terminate_backend(pg_backend_pid());
  else
    perform rehearse_sample_locks();
  end if;
end $$;
SQL
}

measure_lock_summary() {
  sql_psql --dbname="$database" --field-separator=$'\t' --command "
    with ranked as (
      select tag, mode, sampled_at,
        case mode
          when 'AccessExclusiveLock' then 8
          when 'ExclusiveLock' then 7
          when 'ShareRowExclusiveLock' then 6
          when 'ShareLock' then 5
          when 'ShareUpdateExclusiveLock' then 4
          when 'RowExclusiveLock' then 3
          when 'RowShareLock' then 2
          when 'AccessShareLock' then 1
          else 0
        end as rank
      from rehearse_lock_samples
      where locktype = 'relation' and tag is not null and tag <> ''
    )
    select tag, mode,
      round(extract(epoch from max(sampled_at) - min(sampled_at)) * 1000)::text,
      count(*)::text
    from ranked r
    where rank = (select max(rank) from ranked r2 where r2.tag = r.tag)
    group by tag, mode
    order by tag" >"$locks_file"
}

write_summary() {
  local row_count db_size version maintenance probe_stats total_ms
  local probe_count probe_max probe_blocked probe_blocked_max
  local batch_from='' batch_to='' batch_count=0
  local lock_mode='（未采到）' lock_span='-'
  row_count=$(sql_psql --dbname="$database" --command 'select count(*) from cdrs')
  db_size=$(sql_psql --dbname="$database" --command 'select pg_size_pretty(pg_database_size(current_database()))')
  version=$(sql_psql --dbname="$database" --command 'select version()')
  maintenance=$(sql_psql --dbname="$database" --command 'show maintenance_work_mem')
  probe_stats=$(sql_psql --dbname="$database" --field-separator=$'\t' --command "
    select count(*)::text,
      coalesce(round(max(latency_ms), 1)::text, '0'),
      count(*) filter (where latency_ms >= 500)::text,
      coalesce(round(max(latency_ms) filter (where latency_ms >= 500), 1)::text, '0')
    from rehearse_probe_samples")
  IFS=$'\t' read -r probe_count probe_max probe_blocked probe_blocked_max <<<"$probe_stats"
  total_ms=$(awk -F'\t' '{ sum += $2 } END { printf "%.0f", sum + 0 }' "$timings_file")
  measure_lock_summary
  if ((batch)); then
    batch_count=$((target_idx - baseline_idx))
    IFS=$'\t' read -r _ batch_from _ <<<"${journal_rows[$((baseline_idx + 1))]}"
    batch_to=$target_tag
    if [[ -s $locks_file ]]; then
      IFS=$'\t' read -r _ lock_mode lock_span _ <"$locks_file"
    fi
  fi

  mkdir -p -- "$out_dir"
  {
    printf '# 迁移演练结果\n\n'
    printf -- '- 机器：%s\n' "$machine_label"
    printf -- '- PostgreSQL：%s\n' "$version"
    printf -- '- 数据来源：%s\n' "$source_arg"
    printf -- '- 目标迁移：%s\n' "$target_tag"
    printf -- '- 临时库：%s（演练后%s）\n' "$database" "$(
      if ((keep)); then printf '保留'; else printf '删除'; fi
    )"
    printf -- '- cdrs 行数：%s\n' "$row_count"
    printf -- '- 数据库大小：%s\n' "$db_size"
    printf -- '- maintenance_work_mem：%s\n' "$maintenance"
    printf -- '- 写入探针：每 50ms 一次（插入 cdrs 后回滚），样本 %s 个；最大延迟 %s ms\n' \
      "$probe_count" "$probe_max"
    printf -- '- 探针 ≥500ms 的样本：%s 个，最长 %s ms\n' "$probe_blocked" "$probe_blocked_max"
    printf -- '- 迁移总耗时：%s ms（不含数据准备）\n' "$total_ms"
    printf -- '- 部署窗口估算：%s ms 迁移 + 服务重启与健康检查（按 30s 重启 + 10s 检查估算）≈ %s 秒\n\n' \
      "$total_ms" "$(awk -v ms="$total_ms" 'BEGIN { printf "%.1f", (ms + 40000) / 1000 }')"
    if ((batch)); then
      printf '本模式与真实 drizzle migrator 一致：本轮 %s 个待执行迁移放在同一个事务里，\n' "$batch_count"
      printf '锁一直持有到整批提交，所以总墙钟就是这一批的持锁时长。\n\n'
      printf '| 迁移范围 | 条数 | 总墙钟 (ms) | 最强锁 | 持锁跨度 (ms) | 探针最大 (ms) | 探针 ≥500ms |\n'
      printf '| --- | ---: | ---: | --- | ---: | ---: | --- |\n'
      printf '| %s → %s | %s | %s | %s | %s | %s | %s 个（最长 %s ms） |\n' \
        "$batch_from" "$batch_to" "$batch_count" "$total_ms" "$lock_mode" "$lock_span" \
        "$probe_max" "$probe_blocked" "$probe_blocked_max"
    else
      printf '锁采样间隔 100ms；「持锁跨度」是同一迁移事务下该锁模式的首末采样间隔，\n'
      printf '因为锁一直持有到提交，它约等于该文件的墙钟耗时。\n\n'
      printf '| 迁移 | 墙钟 (ms) | 最强锁 | 持锁跨度 (ms) | 锁行数 |\n'
      printf '| --- | ---: | --- | ---: | ---: |\n'
      awk -F'\t' '
        FILENAME == ARGV[1] { mode[$1] = $2; span[$1] = $3; count[$1] = $4; next }
        {
          printf "| %s | %s | %s | %s | %s |\n", $1, $2,
            (($1 in mode) ? mode[$1] : "（未采到）"),
            (($1 in span) ? span[$1] : "-"),
            (($1 in count) ? count[$1] : "0")
        }
      ' "$locks_file" "$timings_file"
    fi
    printf '\n## 说明\n\n'
    printf -- '- 本结果是开发机上的演练，不是服务器 B 的基线；上线后在 B 上用生产备份重做一次。\n'
    printf -- '- 原型数据使用合成号码；本文件不含电话号码、密钥或连接串。\n'
    printf -- '- 探针与锁采样都是抽样，短于采样间隔的锁可能只被记录一次或不出现。\n'
    if ((!batch)); then
      printf -- '- 默认模式按文件分事务计时；真实 migrator 把本轮所有待执行迁移放在同一个事务里，有多个待执行迁移时实际持锁时长是整批的时长，下面的每文件数字会低估阻塞，部署前应再用 --batch 量一次。\n'
    fi
  } >"$out_dir/summary.md"

  {
    printf '# sampled_at\ttag\tmode\trelation\tgranted\n'
    sql_psql --dbname="$database" --field-separator=$'\t' --command "
      select sampled_at, coalesce(tag, ''), mode, relation, granted
      from rehearse_lock_samples
      order by sampled_at, mode"
  } >"$out_dir/lock-timeline.txt"

  {
    printf '# sampled_at\tlatency_ms\tok\terror\n'
    sql_psql --dbname="$database" --field-separator=$'\t' --command "
      select sampled_at, latency_ms, ok, coalesce(error, '')
      from rehearse_probe_samples
      order by sampled_at"
  } >"$out_dir/probe-latency.txt"

  printf '证据写入 %s\n' "$out_dir" >&2
}

# ---------------------------------------------------------------- 主流程

printf '演练：%s -> %s（临时库 %s）\n' "$source_arg" "$target_tag" "$database" >&2

case $source_arg in
  db:*)
    source_db=${source_arg#db:}
    [[ $source_db != fs_billing ]] || fail '拒绝从 fs_billing 复制：演练只使用临时库'
    [[ $source_db != "$database" ]] || fail '源库与临时库不能同名'
    drop_database "$database"
    create_database --template="$source_db" "$database" ||
      fail "无法从 $source_db 复制（源库可能仍有连接）"
    ;;
  prototype:*)
    baseline_arg=${source_arg#prototype:}
    baseline_entry=$(find_entry "$baseline_arg") ||
      fail "找不到原型基线迁移：$baseline_arg"
    IFS=$'\t' read -r baseline_idx baseline_tag _ <<<"$baseline_entry"
    ((baseline_idx <= target_idx)) ||
      fail "原型基线 $baseline_tag 晚于目标 $target_tag"
    drop_database "$database"
    create_database "$database"
    prepare_migration_table
    for ((idx = 0; idx <= baseline_idx; idx++)); do
      IFS=$'\t' read -r _ tag when <<<"${journal_rows[$idx]}"
      apply_migration "$idx" "$tag" "$when" 0
    done
    seed_prototype "$baseline_idx"
    ;;
  empty)
    drop_database "$database"
    create_database "$database"
    ;;
  /*)
    drop_database "$database"
    create_database "$database"
    pg_restore --dbname="$database" --no-owner --no-privileges \
      --exit-on-error "$source_arg" ||
      fail "pg_restore 失败：$source_arg"
    ;;
  *)
    fail "无法识别的数据来源：$source_arg"
    ;;
esac

# 重新读取已应用迁移，确定从哪一条开始计时。
if [[ $(sql_psql --dbname="$database" \
  --command "select to_regclass('drizzle.__drizzle_migrations') is not null") == t ]]; then
  applied=$(sql_psql --dbname="$database" \
    --command "select coalesce(string_agg(created_at::text, ',' order by created_at), '') from drizzle.__drizzle_migrations")
else
  applied=''
fi

if [[ -z $applied ]]; then
  baseline_idx=-1
else
  IFS=',' read -r -a applied_values <<<"$applied"
  baseline_idx=$((${#applied_values[@]} - 1))
  for i in "${!applied_values[@]}"; do
    ((i < ${#journal_rows[@]})) || fail '迁移记录多于 journal'
    IFS=$'\t' read -r _ tag when <<<"${journal_rows[$i]}"
    [[ ${applied_values[$i]} == "$when" ]] ||
      fail "迁移记录与 journal 不一致：第 $i 条应为 $tag（$when），实际 ${applied_values[$i]}"
  done
fi

((baseline_idx <= target_idx)) ||
  fail "源库已应用 $target_tag 之后的迁移；换一个目标或使用基准库"

# 从下一个未应用的文件开始计时。
if ((baseline_idx < target_idx)); then
  ((baseline_idx >= 0)) || prepare_migration_table
  prepare_probe
  sampler_pid=$(start_watch 0.1 'select rehearse_watch_locks();' fsb-rehearse-lock-sampler)
  probe_pid=$(start_watch 0.05 'select rehearse_watch_probe();' fsb-rehearse-probe)
  # 等两个 \watch 会话连上，避免短迁移一条探针样本都没采到。
  sleep 2
  if ((batch)); then
    apply_batch "$baseline_idx" "$target_idx"
  else
    for ((idx = baseline_idx + 1; idx <= target_idx; idx++)); do
      IFS=$'\t' read -r _ tag when <<<"${journal_rows[$idx]}"
      apply_migration "$idx" "$tag" "$when" 1
    done
  fi
  stop_watchers
else
  printf '没有待应用的迁移（源库已在 %s 或更晚）\n' "$target_tag" >&2
fi

if [[ -n $out_dir ]]; then
  write_summary
else
  printf '未指定 --out，跳过证据文件。\n' >&2
fi

if ((keep)); then
  printf '保留临时库 %s\n' "$database" >&2
else
  drop_database "$database"
fi
