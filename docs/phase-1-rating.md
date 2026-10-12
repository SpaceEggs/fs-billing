# 阶段 1 验收记录

分支：`phase-1-rating`。

验证日期：2026-10-12。环境：Linux x64，Node.js 24.21.0，pnpm 10.34.7。

## 数据形状

| 类型                                               | 说明                                                                                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Money<C extends Currency>`                        | `{ currency: C; value: Decimal }` 加仅存在于类型层的 `unique symbol` 品牌，只能由 `money()` 构造                                              |
| `Rate<C>`                                          | `{ currency: C; perMinute: Decimal }`，独立品牌，与 `Money` 不可互换；构造时拒绝负数和超过 4 位小数                                           |
| `BillingCycle`                                     | `{ initialSeconds; incrementSeconds }`，默认 `CYCLE_60_60`                                                                                    |
| `RateEntry<C>` / `RateVersion<C>` / `RateTable<C>` | 前缀条目；带 `effectiveFrom` 的整表版本；租户费率表                                                                                           |
| `Tenant<C>`                                        | 状态、币种、余额、透支额度、费率表                                                                                                            |
| `Authorization<C>`                                 | `{ allowed: true, entry, callableMinutes, maxSeconds }` 或 `{ allowed: false, reason }`，原因为 `租户不存在`/`租户已停用`/`无费率`/`余额不足` |
| `CsvResult<C>`                                     | `{ ok: true, entries }` 或 `{ ok: false, errors: { line, reason }[] }`                                                                        |

`addMoney<C>(a: Money<C>, b: Money<NoInfer<C>>)`：`C` 只从第一个参数推断，因此 CNY + USD 不会被推断为联合类型而通过。运行时也再次校验币种。

## 验收标准

- [x] §5 计费示例表 6 行：`billing.test.ts` 中 `0:00→0/0.00`、`0:01→1/0.10`、`3:10→4/0.40`、`3:50→4/0.40`、`4:00→4/0.40`、`4:01→5/0.50` 全部通过。
- [x] §6.2：`18761234567→1876`、`44712345678→447`（`rates.test.ts`）；`8613800000000` 授权返回 `{ allowed: false, reason: '无费率' }`（`authorize.test.ts`）。
- [x] 生效时间：`2026-09-30 23:59:59` 接通得到 `0.045`，`2026-10-01 00:00:00` 接通得到 `0.048`（北京时间；`2026-10-01 00:00` 对应 `2026-09-30T16:00:00.000Z`）。
- [x] 授权：余额 −35.20、透支 100.00、费率 0.0480 → `callableMinutes: 1350`、`maxSeconds: 14400`；余额 −100.00 → `余额不足`。
- [x] CSV：3 行错误返回 `[{line:3,前缀只能是数字：44a},{line:4,前缀 1876 与第 2 行重复},{line:5,费率不能为负：-0.0450}]`，`ok: false`，不返回任何条目。
- [x] CNY + USD 类型报错：`money.test.ts` 中 `@ts-expect-error` 断言（若某天能编译通过，`tsc` 会报“未使用的 @ts-expect-error”）；CI 另有临时文件实验，输出见下。
- [x] `packages/rating` 行覆盖率 100%（阈值 95%，由 `vitest.config.ts` 强制）。

## 本地运行证据

`pnpm check` 返回 0：ESLint、Prettier、全部包的 TypeScript 检查通过；Vitest 9 个测试文件、96 个测试通过。

`pnpm build` 返回 0。

`pnpm coverage`：

```text
File          | % Stmts | % Branch | % Funcs | % Lines
All files     |     100 |    97.29 |     100 |     100
Lines        : 100% ( 94/94 )
```

临时写入 `packages/rating/src/ci-currency-probe.ts`（`addMoney(money('CNY', '1'), money('USD', '1'))`）后执行 `pnpm --filter @fs-billing/rating typecheck`：

```text
src/ci-currency-probe.ts(2,50): error TS2345: Argument of type 'Money<"USD">' is not assignable to parameter of type 'Money<"CNY">'.
  Type '"USD"' is not assignable to type '"CNY"'.
```

退出码非 0；临时文件已删除。CI 每次运行同一实验。

## 设计取舍

- 计费分钟数用 `Decimal`：60/60 下为整数，6/6 时为 0.1 分钟的倍数，费用 = 计费分钟数 × 费率不舍入，仅 `formatMoney` 显示时 ROUND_HALF_UP 保留 2 位。
- 计费周期解释为“首段/后续段”（`initialSeconds/incrementSeconds`），60/60、6/6、1/1 和 30/6 都可表达。
- 费率版本是整表快照：某时刻生效的是 `effectiveFrom ≤ 接通时刻` 中最晚的版本；早于所有版本的呼叫视为无费率。
- 费率为 0 且可用金额 > 0 时按单通 4 小时封顶放行；可用金额 ≤ 0 时仍以 `余额不足` 拒绝（§7.4 停机）。
- 可打分钟数 ≤ 0 的拒绝原因命名为 `余额不足`。
- CSV：行号为文件物理行号（含表头，从 1 开始）；首行为 `prefix,country,rate` 时视为表头；空行忽略；支持 BOM/CRLF；不支持带引号的字段（国家名含逗号会报列数错误）；重复前缀在后出现的那一行报错；没有任何费率行的文件整体失败。
- 被叫号码不做规范化（`+`、`00` 前缀由调用方处理）。

## 范围边界

纯函数，不访问数据库。费率表持久化、调价操作、话单入账在阶段 2 及以后实现。
