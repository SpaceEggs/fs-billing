# 余额通知邮件样张（阶段 9 PR 3）

用 `renderMail`（`packages/shared/src/mail/templates.ts`）按种子租户的真实形态渲染，站点链接是示例地址；`.txt` 是主题加纯文本部分，`.png` 是 HTML 部分在 680 px 宽的 Chromium 里的截图。同一批邮件也经触发器、发件箱、分发器真实发到 Mailpit，测试在 `apps/worker/src/balance-notices.db.test.ts`（验收 1、2）。

| 样张                                                                                                        | 场景                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [balance_low-gzt007-cny](balance_low-gzt007-cny.png)（[文本](balance_low-gzt007-cny.txt))                   | GZT007，余额 86.27，阈值 100.00，透支 100.00（人民币） |
| [balance_low-sgn011-usd](balance_low-sgn011-usd.png)（[文本](balance_low-sgn011-usd.txt))                   | SGN011，余额 12.30，阈值 20.00，透支 15.00（美元）     |
| [balance_suspended-hzx014-cny](balance_suspended-hzx014-cny.png)（[文本](balance_suspended-hzx014-cny.txt)) | HZX014，余额 −100.36，透支 100.00，可用额度用完        |

措辞沿用 PR 2 的模板，本 PR 没有改。做样张时发现 PR 2 的 HTML 部分有一个排版错误：`<body>` 的 `style` 属性里字体名用了双引号（`"Segoe UI"`），把属性提前截断，字体和颜色设置整段失效（浏览器显示默认字体）。本 PR 改成单引号，并在 `templates.test.ts` 里加了断言。
