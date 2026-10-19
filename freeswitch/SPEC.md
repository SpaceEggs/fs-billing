---
id: freeswitch
type: module-design
title: freeswitch — 交换机侧授权与话单接入
status: draft
parent: architecture
depends-on: [worker]
---

# freeswitch — 交换机侧授权与话单接入

## 职责

交换机侧的参考实现：授权 Lua、billing 拨号计划、`mod_json_cdr` 配置与本机 nginx relay、落盘重推脚本、安装与 SIPp 集成测试。

## 边界

- 不访问数据库、不保存余额、不计算费用；只按 Worker 的 HTTP 契约取授权、推话单。
- 依赖 `worker` 的接口语义；接入步骤见 freeswitch/README.md，请求与响应字段见 docs/worker-api.md。

## 不变量

- 桥接保留原始 `destination_number`；`billing_dialed_number` 在任何校验之前写入，`billing_number` 单独保存为计费投影。
- 授权超时（1.5 秒）、无响应或 5xx 时放行 1800 秒并设置 `billing_unverified=true`；号码投影不一致返回 SIP 503，不降级、不桥接。
- 共享密钥只从全局变量读取，不写进通道变量，避免进入原始话单。
- 话单推送失败时 FreeSWITCH 落盘到 retry 目录，由重推脚本在收到 2xx 后才删除。
