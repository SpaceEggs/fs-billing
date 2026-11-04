#!/usr/bin/env bash
# 上线门禁（验收 13）：发布提交上必须有一次 FreeSWITCH e2e 真实通过。
#
#   ops/checks/require-fs-e2e.sh <发布提交 SHA>
#
# 取该提交最近一次成功的 freeswitch.yml 运行，下载产物
# freeswitch-integration-status 中的 fs-e2e-status.json，要求：
#   status == passed 且 passed == total 且 total > 0，
#   且 total 不小于 FS_E2E_MIN_TESTS（默认 15，用例变少后门禁不能跟着变松）。
# 找不到运行、缺少产物或任一条件不满足都退出非零。只读，不改仓库。
set -euo pipefail

usage() {
  cat <<'EOF'
用法：require-fs-e2e.sh <发布提交 SHA>

环境变量：
  FS_E2E_MIN_TESTS  通过用例总数下限，默认 15
EOF
}

fail() {
  printf '错误：%s\n' "$*" >&2
  exit 1
}

case ${1:-} in
  -h | --help)
    usage
    exit 0
    ;;
esac

[[ $# -eq 1 ]] || {
  usage >&2
  exit 2
}

sha=$1
# gh run list --commit 只匹配完整的 40 位 SHA；短 SHA 会静默匹配不到运行。
[[ $sha =~ ^[0-9a-fA-F]{40}$ ]] ||
  fail "提交 SHA 必须是完整的 40 位十六进制：$sha（gh run list --commit 只匹配完整 SHA）"

min_tests=${FS_E2E_MIN_TESTS:-15}
[[ $min_tests =~ ^[1-9][0-9]*$ ]] || fail "FS_E2E_MIN_TESTS 必须是正整数：$min_tests"
artifact=freeswitch-integration-status
status_file=fs-e2e-status.json

command -v gh >/dev/null 2>&1 || fail '需要 GitHub CLI（gh）'
command -v jq >/dev/null 2>&1 || fail '需要 jq'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
umask 077

run_id=$(gh run list --workflow freeswitch.yml --commit "$sha" --status success --limit 20 \
  --json databaseId,createdAt \
  --jq 'sort_by(.createdAt) | reverse | .[0].databaseId // empty') ||
  fail "无法查询 freeswitch.yml 在提交 $sha 上的运行记录"
[[ -n $run_id ]] || fail "提交 $sha 上找不到成功的 freeswitch.yml 运行"

if ! gh run download "$run_id" --name "$artifact" --dir "$tmp/artifact" >/dev/null; then
  fail "运行 $run_id 没有产物 $artifact"
fi
[[ -f $tmp/artifact/$status_file ]] || fail "产物 $artifact 缺少 $status_file"

status=$(jq -er '.status | strings' "$tmp/artifact/$status_file") ||
  fail '状态文件缺少 status'
passed=$(jq -er '.passed | numbers' "$tmp/artifact/$status_file") ||
  fail '状态文件缺少 passed'
total=$(jq -er '.total | numbers' "$tmp/artifact/$status_file") ||
  fail '状态文件缺少 total'
event=$(jq -r '.event // ""' "$tmp/artifact/$status_file")
image_hash=$(jq -r '.image_hash // ""' "$tmp/artifact/$status_file")
status_sha=$(jq -er '.sha | strings' "$tmp/artifact/$status_file") ||
  fail '状态文件缺少 sha'
[[ -n $status_sha ]] || fail '状态文件缺少 sha'
[[ ${status_sha,,} == "${sha,,}" ]] ||
  fail "状态文件记录的提交 $status_sha 与请求的提交 $sha 不一致（运行 $run_id）"

[[ $passed =~ ^[0-9]+$ ]] || fail "passed 不是非负整数：$passed"
[[ $total =~ ^[0-9]+$ ]] || fail "total 不是非负整数：$total"

[[ $status == passed ]] || fail "状态为 $status，不是 passed（运行 $run_id）"
((total > 0)) || fail '总数为 0，没有可证明的联调用例'
((passed == total)) || fail "通过数 $passed 不等于总数 $total（运行 $run_id）"
((total >= min_tests)) || fail "总数 $total 小于下限 $min_tests（FS_E2E_MIN_TESTS）"

printf 'PASS 提交 %s 上的运行 %s：status=passed，%s/%s，事件 %s，镜像 %s\n' \
  "$sha" "$run_id" "$passed" "$total" "${event:-未知}" "${image_hash:-未知}"
