#!/usr/bin/env bash
# billing_tenant 核对（阶段 10 验收 9）。
#
#   A 上：ops/checks/billing-tenant.sh --extract
#   B 上：ops/checks/billing-tenant.sh --compare <清单>
#
# --extract 扫 FreeSWITCH 的 directory、ACL 与拨号计划，提取 billing_tenant 的取值，
# 转大写去重，并记录每个值出自哪个文件。--compare 用 owner 连接读 tenants.code，
# 输出四类结果：两边一致、只在 FreeSWITCH、只在数据库、仅大小写不同；另有
# 「只在 FreeSWITCH」时退出非零。最后用 freeswitch.md §3.3 的 SQL 检查国内前缀并
# 存档。连接串只从 owner.env 读入环境变量，密码不进命令行与日志（同 ops/backup）。
set -euo pipefail
LC_ALL=C
export LC_ALL
umask 077

usage() {
  cat <<'EOF'
用法：
  billing-tenant.sh --extract [--root <FreeSWITCH 配置根>] [--output <清单>]
  billing-tenant.sh --compare <清单> [--owner-env <文件>]
                    [--output <报告>] [--prefix-output <前缀检查>]

  --extract         在服务器 A 上扫描 directory、ACL 与拨号计划，写清单
  --compare         在服务器 B 上读 tenants.code，与清单比对
  --root            FreeSWITCH 配置根，默认 /etc/freeswitch
  --path            额外扫描的文件或目录，可重复（在默认路径之外追加）
  --output          输出文件；-- 用 - 表示只写标准输出。
                    extract 默认 fs-tags.txt，compare 默认 compare.txt
  --owner-env       owner 环境文件，默认 /etc/fs-billing/owner.env
  --prefix-output   国内前缀 SQL 的输出，默认 prefix-check.txt

清单格式：编码<TAB>来源文件<TAB>原始写法（编码已转大写去重）。
compare 的输出文件名与 docs/evidence/phase-10/billing-tenant/ 的证据名一致。
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

mode=''
list_file=''
root=/etc/freeswitch
output=''
owner_env=/etc/fs-billing/owner.env
prefix_output=''
extra_paths=()

while (($#)); do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --extract)
      [[ -z $mode || $mode == extract ]] || fail '--extract 与 --compare 只能选一个'
      mode=extract
      shift
      ;;
    --compare)
      [[ -z $mode || $mode == compare ]] || fail '--extract 与 --compare 只能选一个'
      (($# >= 2)) || fail '--compare 需要清单文件'
      mode=compare
      list_file=$2
      shift 2
      ;;
    --root)
      (($# >= 2)) || fail '--root 需要目录'
      root=$2
      shift 2
      ;;
    --path)
      (($# >= 2)) || fail '--path 需要文件或目录'
      extra_paths+=("$2")
      shift 2
      ;;
    --output)
      (($# >= 2)) || fail '--output 需要文件路径'
      output=$2
      shift 2
      ;;
    --owner-env)
      (($# >= 2)) || fail '--owner-env 需要文件路径'
      owner_env=$2
      shift 2
      ;;
    --prefix-output)
      (($# >= 2)) || fail '--prefix-output 需要文件路径'
      prefix_output=$2
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
  exit 2
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 从 XML 文件里取出 billing_tenant 的取值。支持三种写法：
#   <variable name="billing_tenant" value="ABC001" />
#   <param value="ABC001" name="billing_tenant" />
#   <action ... data="billing_tenant=ABC001" /> 或 {billing_tenant=ABC001}
# 注释先剥掉；$ 开头的引用（如 ${billing_tenant}）不是定义，跳过。
extract_from_file() {
  local file=$1 rel=$2
  awk -v file="$rel" '
    BEGIN { content = "" }
    { content = content $0 "\n" }
    END {
      # 先剥掉 XML 注释（含跨行注释）；注释里的示例值不算配置。
      while (match(content, /<!--/)) {
        before = substr(content, 1, RSTART - 1)
        rest = substr(content, RSTART + 4)
        if (match(rest, /-->/)) after = substr(rest, RSTART + 3)
        else after = ""
        content = before after
      }

      rest = content
      while (match(rest, /name[[:space:]]*=[[:space:]]*["\047]billing_tenant["\047][^>]*value[[:space:]]*=[[:space:]]*["\047][^"\047]*["\047]/)) {
        fragment = substr(rest, RSTART, RLENGTH)
        sub(/.*value[[:space:]]*=[[:space:]]*["\047]/, "", fragment)
        sub(/["\047].*$/, "", fragment)
        if (fragment != "" && fragment !~ /\$/) printf "%s\t%s\n", file, fragment
        rest = substr(rest, RSTART + RLENGTH)
      }

      rest = content
      while (match(rest, /value[[:space:]]*=[[:space:]]*["\047][^"\047]*["\047][^>]*name[[:space:]]*=[[:space:]]*["\047]billing_tenant["\047]/)) {
        fragment = substr(rest, RSTART, RLENGTH)
        sub(/^value[[:space:]]*=[[:space:]]*["\047]/, "", fragment)
        sub(/["\047].*$/, "", fragment)
        if (fragment != "" && fragment !~ /\$/) printf "%s\t%s\n", file, fragment
        rest = substr(rest, RSTART + RLENGTH)
      }

      rest = content
      while (match(rest, /billing_tenant[[:space:]]*=[[:space:]]*["\047]?[A-Za-z0-9_.@:\/-]+/)) {
        fragment = substr(rest, RSTART, RLENGTH)
        sub(/.*=[[:space:]]*["\047]?/, "", fragment)
        if (fragment != "" && fragment !~ /\$/) printf "%s\t%s\n", file, fragment
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
  ' "$file"
}

run_extract() {
  [[ -d $root ]] || fail "FreeSWITCH 配置根目录不存在：$root"
  output=${output:-fs-tags.txt}

  local -a scan_paths=()
  local candidate
  for candidate in "$root/directory" "$root/dialplan"; do
    [[ -d $candidate ]] && scan_paths+=("$candidate")
  done
  # ACL 通常在 autoload_configs/acl.conf.xml；名字里带 acl 的 XML 都扫。
  for candidate in "$root"/autoload_configs/*acl*.xml; do
    [[ -f $candidate ]] && scan_paths+=("$candidate")
  done
  if ((${#extra_paths[@]})); then
    scan_paths+=("${extra_paths[@]}")
  fi
  ((${#scan_paths[@]})) ||
    fail "在 $root 下没有找到 directory、ACL 或 dialplan（可用 --path 指定）"

  local matches=$tmp/matches.tsv
  : >"$matches"
  local path file rel
  for path in "${scan_paths[@]}"; do
    [[ -e $path ]] || fail "扫描路径不存在：$path"
    while IFS= read -r -d '' file; do
      rel=${file#"$root"/}
      extract_from_file "$file" "$rel" >>"$matches"
    done < <(find "$path" -type f \( -name '*.xml' -o -name '*.conf' \) -print0)
  done

  local deduped=$tmp/deduped.tsv
  awk -F '\t' '
    {
      code = toupper($2)
      if (code == "") next
      if (code in sources) {
        if (index("," sources[code] ",", "," $1 ",") == 0) sources[code] = sources[code] "," $1
      } else {
        sources[code] = $1
        codes[++n] = code
      }
      if (code in spellings) {
        if (index("," spellings[code] ",", "," $2 ",") == 0) spellings[code] = spellings[code] "," $2
      } else {
        spellings[code] = $2
      }
    }
    END {
      for (i = 1; i <= n; i++) {
        code = codes[i]
        print code "\t" sources[code] "\t" spellings[code]
      }
    }
  ' "$matches" | sort -t $'\t' -k1,1 >"$deduped"

  local total
  total=$(wc -l <"$deduped" | tr -d ' ')

  {
    printf '# FreeSWITCH billing_tenant 清单\n'
    printf '# 生成时间：%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# 配置根目录：%s\n' "$root"
    printf '# 格式：编码<TAB>来源文件<TAB>原始写法；编码已转大写去重。\n'
    if awk -F '\t' '$3 ~ /,/' "$deduped" | grep -q .; then
      printf '# 注意：下列编码转大写后有多种写法，需要统一：\n'
      awk -F '\t' '$3 ~ /,/ { printf "#   %s（%s）\n", $1, $3 }' "$deduped"
    fi
    cat "$deduped"
  } >"$tmp/out"

  if [[ $output == - ]]; then
    cat "$tmp/out"
  else
    cat "$tmp/out" >"$output"
    printf '清单写入 %s（%s 个编码）\n' "$output" "$total"
  fi
  if ((${#extra_paths[@]} == 0)) && [[ ! -d $root/dialplan ]]; then
    printf '提示：%s/dialplan 不存在，本次只扫了 directory 与 ACL。\n' "$root" >&2
  fi
}

# 把 DATABASE_URL 拆成 PG* 环境变量：连接串只进环境，密码不进命令行与日志。
# 写法与 ops/backup/backup.sh 保持一致，只支持仓库 env 示例里的
# postgresql://用户:密码@主机:端口/库名（可带 ?sslmode=）。
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

# 打印一个分类。参数：标题、条数、文件。
print_section() {
  printf '\n## %s（%s）\n' "$1" "$2"
  if [[ -s $3 ]]; then
    cat "$3"
  else
    printf '（无）\n'
  fi
}

run_compare() {
  [[ -f $list_file && -r $list_file ]] || fail "读不到清单：$list_file"
  [[ -r $owner_env ]] || fail "读不到 owner 环境文件：$owner_env"
  output=${output:-compare.txt}
  prefix_output=${prefix_output:-prefix-check.txt}

  command -v psql >/dev/null 2>&1 ||
    fail '缺少 psql（Debian 包 postgresql-client-17）'

  # shellcheck source=/dev/null
  . "$owner_env"
  [[ -n ${DATABASE_URL:-} ]] || fail "owner 环境文件里没有 DATABASE_URL：$owner_env"
  parse_database_url
  export PGAPPNAME=fs-billing-billing-tenant
  export PGCONNECT_TIMEOUT=10

  local fs_file=$tmp/fs.tsv db_file=$tmp/db.tsv
  : >"$fs_file"
  : >"$db_file"

  local code sources orig seen_duplicate=0
  declare -A fs_sources=() fs_orig=() fs_count=()
  while IFS=$'\t' read -r code sources orig; do
    [[ -z $code ]] && continue
    [[ $code == \#* ]] && continue
    code=${code%$'\r'}
    sources=${sources%$'\r'}
    orig=${orig%$'\r'}
    code=${code^^}
    fs_count[$code]=$(( ${fs_count[$code]:-0} + 1 ))
    if ((fs_count[$code] > 1)); then
      seen_duplicate=1
    fi
    fs_sources[$code]=${sources:-未知}
    fs_orig[$code]=${orig:-$code}
  done <"$list_file"
  ((${#fs_orig[@]})) || fail "清单里没有编码：$list_file"

  # 数据库侧：保留原始大小写；同一编码（转大写后）出现多次要提示。
  local db_raw=$tmp/db.raw
  psql -X -v ON_ERROR_STOP=1 -A -t -c 'SELECT code FROM tenants ORDER BY code;' >"$db_raw" ||
    fail '读取 tenants.code 失败'

  declare -A db_orig=() db_count=()
  local raw upper duplicate_db=0
  while IFS= read -r raw; do
    [[ -z $raw ]] && continue
    raw=${raw%$'\r'}
    upper=${raw^^}
    db_count[$upper]=$(( ${db_count[$upper]:-0} + 1 ))
    if ((db_count[$upper] > 1)); then
      duplicate_db=1
      db_orig[$upper]+=",$raw"
    else
      db_orig[$upper]=$raw
    fi
  done <"$db_raw"

  local both=$tmp/both.txt only_fs=$tmp/only-fs.txt only_db=$tmp/only-db.txt case_only=$tmp/case-only.txt
  : >"$both"
  : >"$only_fs"
  : >"$only_db"
  : >"$case_only"

  local spelling same_spelling
  for code in "${!fs_orig[@]}"; do
    if [[ -n ${db_orig[$code]+x} ]]; then
      same_spelling=0
      IFS=',' read -r -a spellings <<<"${fs_orig[$code]}"
      for spelling in "${spellings[@]}"; do
        [[ $spelling == "${db_orig[$code]}" ]] && same_spelling=1
      done
      if ((same_spelling)); then
        printf '%s\n' "$code" >>"$both"
      else
        printf '%s\tFreeSWITCH=%s\t数据库=%s\n' "$code" "${fs_orig[$code]}" "${db_orig[$code]}" >>"$case_only"
      fi
    else
      printf '%s\t来源：%s\n' "$code" "${fs_sources[$code]}" >>"$only_fs"
    fi
  done
  for code in "${!db_orig[@]}"; do
    [[ -n ${fs_orig[$code]+x} ]] || printf '%s\t数据库=%s\n' "$code" "${db_orig[$code]}" >>"$only_db"
  done

  sort -o "$both" "$both"
  sort -o "$only_fs" "$only_fs"
  sort -o "$only_db" "$only_db"
  sort -o "$case_only" "$case_only"

  local n_both n_only_fs n_only_db n_case
  n_both=$(wc -l <"$both" | tr -d ' ')
  n_only_fs=$(wc -l <"$only_fs" | tr -d ' ')
  n_only_db=$(wc -l <"$only_db" | tr -d ' ')
  n_case=$(wc -l <"$case_only" | tr -d ' ')

  {
    printf '# billing_tenant 核对\n'
    printf '# 时间：%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# 清单：%s\n' "$list_file"
    printf '# 数据库：%s@%s:%s/%s（owner 连接）\n' "$PGUSER" "$PGHOST" "$PGPORT" "$PGDATABASE"
    printf '# FreeSWITCH 编码：%s，数据库租户：%s\n' "${#fs_orig[@]}" "${#db_orig[@]}"
    if ((seen_duplicate)); then
      printf '# 警告：清单里同一编码（转大写后）出现多次，已按一次计算。\n'
    fi
    if ((duplicate_db)); then
      printf '# 警告：tenants.code 里同一编码（转大写后）出现多次。\n'
    fi
    print_section '两边一致' "$n_both" "$both"
    print_section '只在 FreeSWITCH' "$n_only_fs" "$only_fs"
    print_section '只在数据库' "$n_only_db" "$only_db"
    print_section '仅大小写不同' "$n_case" "$case_only"
    printf '\n## 结论\n'
    if ((n_only_fs > 0)); then
      printf '失败：%s 个编码只在 FreeSWITCH。这些呼叫会进入未归属话单，必须先在后台建租户或改正 FreeSWITCH 配置。\n' "$n_only_fs"
    else
      printf '通过：没有只在 FreeSWITCH 的编码。\n'
    fi
    if ((n_case > 0)); then
      printf '提示：%s 个编码仅大小写不同。授权与入库都转大写能对上，但两边写法应统一。\n' "$n_case"
    fi
  } >"$tmp/report"

  # 国内前缀检查（freeswitch.md §3.3）：以 owner 身份跑，结果存档。
  local prefix_sql
  prefix_sql=$(
    cat <<'SQL'
WITH effective AS (
  SELECT DISTINCT ON (tenant_id) id, tenant_id
  FROM rate_versions
  WHERE effective_from <= now()
  ORDER BY tenant_id, effective_from DESC
)
SELECT t.code, e.prefix, e.country, e.rate
FROM effective v
JOIN rate_entries e ON e.rate_version_id = v.id AND e.tenant_id = v.tenant_id
JOIN tenants t ON t.id = v.tenant_id
WHERE e.prefix ~ '^0'
   OR (e.prefix !~ '^86' AND (
     e.country ~* '(中国|china|\ycn\y)'
     OR e.prefix ~ '^1[3-9]'
   ))
ORDER BY t.code, e.prefix;
SQL
  )

  local prefix_tmp=$tmp/prefix.txt
  {
    printf '# 国内费率前缀检查（docs/freeswitch.md §3.3）\n'
    printf '# 时间：%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# 数据库：%s@%s:%s/%s（owner 连接）\n' "$PGUSER" "$PGHOST" "$PGPORT" "$PGDATABASE"
    printf '# 结果为空表示没有以 0 开头或未带 86 的国内前缀候选。\n'
    psql -X -v ON_ERROR_STOP=1 -P pager=off -c "$prefix_sql"
  } >"$prefix_tmp" || fail '国内前缀 SQL 执行失败'

  if [[ $output == - ]]; then
    cat "$tmp/report"
  else
    cat "$tmp/report" >"$output"
    printf '报告写入 %s\n' "$output"
  fi
  if [[ $prefix_output == - ]]; then
    cat "$prefix_tmp"
  else
    cat "$prefix_tmp" >"$prefix_output"
    printf '国内前缀检查写入 %s\n' "$prefix_output"
  fi

  if ((n_only_fs > 0)); then
    return 1
  fi
  return 0
}

if [[ $mode == extract ]]; then
  run_extract
else
  run_compare
fi
