# 阶段 9 PR 3 证据：余额提醒与停机通知

2026-10-29，本机 PostgreSQL 17.9（Docker）、Mailpit v1.31.5、Node 24.22.1。设计见 [phase-9-design.md](../../phase-9-design.md)，实现时的补充与更正见该文「余额提醒与停机通知」一节末的「PR 3 实现时对本章的补充与更正」。

## 测试结果

| 命令             | 结果                                                                                                                             | 输出                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `pnpm check`     | 退出 0：lint、格式检查、类型检查全过；根目录单元测试 50 个文件、1006 通过 3 跳过；Web 单元测试 50 个文件、656 通过；Web 构建成功 | [pr3-pnpm-check.txt](pr3-pnpm-check.txt)         |
| `pnpm test:db`   | 退出 0：63 个文件、881 个测试全部通过                                                                                            | [pr3-pnpm-test-db.txt](pr3-pnpm-test-db.txt)     |
| `pnpm test:idor` | 退出 0：1 个文件、36 个测试全部通过                                                                                              | [pr3-pnpm-test-idor.txt](pr3-pnpm-test-idor.txt) |

`pnpm check` 第一次跑时 Web 的 `statements-tab.test.tsx` 有一个用例超时（机器上同时在跑性能测量，负载平均 8 以上）；单独重跑 20 个用例全过，负载降下来后整套重跑通过，输出里是通过的那次。本 PR 没有改 Web。

新增测试：`packages/db/src/balance-notices.db.test.ts` 26 个、`packages/db/src/balance-notices-backfill.db.test.ts` 3 个、`apps/worker/src/balance-notices.db.test.ts` 3 个，`packages/shared/src/mail/templates.test.ts` 里的 HTML 属性断言；改动的既有测试：`admin/rates.db.test.ts` 的 `snapshot` 补上 `ORDER BY created_at`（`logs.at(-1)` 原来依赖堆的物理顺序，本 PR 新增用例之后整套运行连续两次取到 `tenant_create`，单文件运行不受影响，具体触发原因没有深究）、`migrate.db.test.ts` 的迁移条数（22 → 23）与 Drizzle 表数（25 → 26）。

## 验收 1–3 与决定 24–30

| 验收 / 决定                                               | 测试（均在上面三个文件里）                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 验收 1：120 → 80 → 50 → 150 → 90 收 2 封                  | `balance-notices.db.test.ts` / `queues one notice per crossing: 120, 80, 50, 150, 90`（发件箱 2 行、状态序列、金额字符串与模板渲染）；`does not fire at exactly the threshold`；Worker `balance-notices.db.test.ts` / `delivers the two balance notices through Mailpit`（Mailpit 累计 1、1、1、2 封，主题、收件人、正文、`balance_alert_deliveries`） |
| 验收 2：余额 + 透支降到 0 收 1 封停机通知                 | `queues one suspension notice when balance plus overdraft reaches zero`、`does not repeat while the tenant stays suspended`、`notifies again after a top-up and a second drop`；Worker `delivers the suspension notice through Mailpit`                                                                                                                |
| 验收 3：停机通知阈值与授权「余额不足」的关系              | `authorize rejects for insufficient balance while available credit is below one minute but no suspension notice is queued`（0.05 元/分钟、可用额度 0.03 授权拒绝而无停机通知，0 时有）、`a suspension notice is queued exactly when available credit is not above zero`                                                                                |
| 决定 24：只用租户阈值，0 = 不提醒                         | `a threshold of zero disables the low balance reminder`                                                                                                                                                                                                                                                                                                |
| 决定 25：只发租户通知邮箱，不抄送管理员                   | `only the tenant notification mailboxes are addressed`、Worker 测试里 Mailpit 收件人逐封断言                                                                                                                                                                                                                                                           |
| 决定 26：收件人为空 → skipped，状态照常前进               | `an empty recipient list is skipped and does not re-arm`、`recipients that are not plain addresses are dropped and an all-invalid list is skipped`、Worker `skipped notices are never sent`                                                                                                                                                            |
| 决定 27：停用租户 skipped / `tenant_disabled`，重启不补发 | `a disabled tenant keeps its state and sends nothing`                                                                                                                                                                                                                                                                                                  |
| 决定 28：同时越过两条线只发停机通知                       | `crossing both lines at once sends only the suspension notice`                                                                                                                                                                                                                                                                                         |
| 决定 29：改阈值或透支额度静默同步                         | `changing the threshold syncs silently`、`changing the overdraft limit syncs the suspension state silently`、`a new tenant starts with a state row and sends nothing at creation`                                                                                                                                                                      |
| 决定 30：停机 = 余额 + 透支 ≤ 0                           | 验收 3 的两个用例与 `queues one suspension notice …`（可用额度 0.01 不发、0 才发）                                                                                                                                                                                                                                                                     |

## 并发

状态判定与设置保存、重算之间的排队关系用 `pg_locks` / `pg_blocking_pids` 轮询确认「真的在等」，不靠睡眠：`a settings save waits for a transaction holding the balance row and then sees its balance`（持余额行锁的写入者把余额改到 50，设置保存在 `sync_balance_notice_state` 的 `FOR UPDATE` 上排队，提交后读到 50 而不是陈旧的 120；去掉 `FOR UPDATE` 该用例会失败）、`a charge and a settings save in either order end with flags matching the final balance and settings`（两种先后顺序，标志与最终余额和设置重新算出的一致，邮件数分别为 0 与 1）、`rebuild_tenant_balances waits for an in-flight charge and leaves one notice and consistent flags`、`concurrent charges crossing the threshold queue one notice`（用租户锁轮询取代了原来的 `setTimeout`）。

## 迁移与回填

`balance-notices-backfill.db.test.ts`：在停在 0023 之前、灌了种子的库上执行 0023（`backfilled tenants queue no email`）：发件箱仍为 0 行；每个租户一行状态，标志与余额口径逐租户一致（HZX014、GLB009 已停机；ABC001、GZT007 低余额未停机；没有提醒设置的租户不记低余额），序号全为 0；升级后已在线下的租户继续扣费不再通知。`seeding a migrated database queues no balance notice and keeps the states`：迁移后的库上播种，触发器确实跑过（HZX014 的序号为 1），但发件箱为空，再播一次仍为空。`migrates an empty database from scratch`：空库从头迁移，状态表为空，两个触发器存在。共享测试库（`pnpm test:db` 的全局准备）同样是「空库迁移再播种」。

## 吞吐

见 [balance-notice-perf.md](balance-notice-perf.md)。用的是合成的 PORTALBIG 形状替代库，不是真实的 `fs_billing_perf`。微基准：触发器每次余额变化约 +11 µs，约为一笔扣费的 0.3%，越线时约 +0.2 ms；端到端吞吐（单租户 247.3 → 242.8 笔/秒，40 个租户 776.3 → 772.1 笔/秒）的差异在噪声之内，无法分辨。

## 样张

[balance-samples](balance-samples/README.md)：三封余额类邮件的主题、文本与 HTML 截图；同时修正了 PR 2 模板里 `<body>` 的 `style` 属性引号错误。
