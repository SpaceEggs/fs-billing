#!/usr/bin/env bash
# 在 debian:trixie 容器内以 root 运行：用桩命令模拟 apt 包脚本与 systemd，验证 install.sh 不让服务启动。
set -euo pipefail
script=${1:-/repo/freeswitch/install/install.sh}
stubs=/tmp/stubs
state=/tmp/state
mkdir -p "$stubs"

stub() { printf '#!/bin/bash\n%s\n' "$2" > "$stubs/$1"; chmod +x "$stubs/$1"; }
# 包脚本行为：总会 enable；除非 policy-rc.d 返回 101 或单元已屏蔽，否则启动服务。
stub apt-get '
if [[ " $* " == *" freeswitch="* ]]; then
    touch '"$state"'/enabled
    rc=0; [[ -x /usr/sbin/policy-rc.d ]] && { /usr/sbin/policy-rc.d freeswitch start; rc=$?; } || true
    if (( rc != 101 )) && [[ ! -e '"$state"'/masked ]]; then touch '"$state"'/active '"$state"'/started; fi
    [[ -n ${FAIL_INSTALL:-} ]] && exit 100
fi
exit 0'
stub systemctl '
echo "$*" >> '"$state"'/systemctl.log
case "$1" in
    mask) touch '"$state"'/masked ;;
    unmask) rm -f '"$state"'/masked ;;
    stop) rm -f '"$state"'/active ;;
    disable) rm -f '"$state"'/enabled; [[ $2 == --now ]] && rm -f '"$state"'/active ;;
esac'
stub curl 'while (($#)); do [[ $1 == -o ]] && printf binary-key > "$2"; shift; done'
stub apt-mark 'exit 0'
stub dpkg 'echo amd64'
stub lua5.3 'exit 0'
stub ldd 'echo liblua5.3.so.0'
export PATH=$stubs:$PATH
printf 'token\n' > /tmp/token

failures=()
check() { "${@:2}" || failures+=("$1"); }
run() {
    rm -rf "$state" /run/systemd/system; mkdir -p "$state"
    rm -f /usr/sbin/policy-rc.d
    [[ $1 == systemd* ]] && mkdir -p /run/systemd/system
    [[ $1 == docker ]] && printf '#!/bin/sh\nexit 0\n' > /usr/sbin/policy-rc.d
    status=0
    FAIL_INSTALL=$([[ $1 == systemd-fail ]] && echo 1 || true) bash "$script" /tmp/token > "$state/out.log" 2>&1 || status=$?
}

run systemd-ok
check 'systemd 成功：退出码 0' test "$status" = 0
check 'systemd 成功：安装期间未启动' test ! -e "$state/started"
check 'systemd 成功：服务未运行' test ! -e "$state/active"
check 'systemd 成功：未开机自启' test ! -e "$state/enabled"
check 'systemd 成功：已解除屏蔽' test ! -e "$state/masked"
check 'systemd 成功：policy-rc.d 已移除' test ! -e /usr/sbin/policy-rc.d

run systemd-fail
check 'systemd 失败：退出码非 0' test "$status" != 0
check 'systemd 失败：安装期间未启动' test ! -e "$state/started"
check 'systemd 失败：服务未运行' test ! -e "$state/active"
check 'systemd 失败：保持屏蔽' test -e "$state/masked"
check 'systemd 失败：policy-rc.d 已移除' test ! -e /usr/sbin/policy-rc.d

run docker
check 'Docker：退出码 0' test "$status" = 0
check 'Docker：安装期间未启动' test ! -e "$state/started"
check 'Docker：不调用 systemctl' test ! -e "$state/systemctl.log"
check 'Docker：恢复原 policy-rc.d' grep -qx 'exit 0' /usr/sbin/policy-rc.d

if ((${#failures[@]})); then printf '%s\n' "${failures[@]}" >&2; exit 1; fi
echo 'install.sh service tests passed'
