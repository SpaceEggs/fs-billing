---
id: rating
type: module-design
title: rating — 计费核心纯函数
status: draft
parent: architecture
---

# rating — 计费核心纯函数

## 职责

计费与号码规则的唯一实现：金额与费率类型、号码归一化与投影核验、费率匹配与版本选择、计费分钟与费用、授权判定、费率 CSV 解析与导出、北京时间与时长工具。

## 边界

- 只依赖 `decimal.js`：不访问数据库、网络、时钟与日志，时间由调用方以 `Date` 传入。
- 被 `packages/db` 与 `apps/worker` 复用；`apps/api` 只在开发依赖里引用（测试用）。
- 业务规则由 `architecture`（design.md §4.2、§5、§6）定义，这里不重复。

## 不变量

- 金额与费率是 `Money<Currency>` / `Rate<Currency>` 品牌类型，由字符串进入 Decimal；乘除不提前舍入，只有显示（`formatMoney`）用 `ROUND_HALF_UP` 保留 2 位。
- 计费周期表达为 `initialSeconds / incrementSeconds`，默认 60/60；6/6、1/1、30/6 不改代码。
- 费率是整表版本快照：某时刻生效的是 `effectiveFrom ≤ 接通时刻` 中最晚的版本；早于所有版本视为无费率。
- `DialedNumber` 只能由 `parseDialedNumber` 产生（纯数字、不以 `00` 开头）；`longestPrefix`、`findRate`、`authorize` 只接受它，传普通字符串是类型错误。
- `resolveBillingNumber` 是号码归一化与投影核验的唯一实现，授权与话单共用。
- 零费率且可用金额 > 0 时按单通上限 14400 秒授权，不返回 `Infinity`；可用金额 ≤ 0 仍以「余额不足」拒绝。
- 行覆盖率门槛 95%（`pnpm coverage`）。

## 已知限制

- 金额保护规则 `money/no-number-money` 只是保守的静态检查：它能拦住本包内的金额命名、本地别名与小数运算，但不能证明跨函数或外部数据一定是金额。
