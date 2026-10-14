# 阶段 4 Web 外壳运行与验收

阶段 4 前端代码位于 `apps/web`，分支 `phase-4-web`。本文说明运行方法、实现决定和与设计稿的差异。验收复选框由 Bot 验证后勾选。

## 运行

先按 [阶段 4 API 运行与验收](phase-4-api.md) 配置 `.env`，然后启动数据库、迁移并写入种子数据。

```sh
pnpm db:up
pnpm db:migrate
pnpm db:seed
SEED_AUTH_PASSWORD=<开发密码> pnpm --filter @fs-billing/api auth:seed
pnpm --filter @fs-billing/api start
pnpm --filter @fs-billing/web dev
```

开发服务器地址为 `http://127.0.0.1:5173`，`/api` 由 Vite 代理到 `FS_BILLING_API_ORIGIN`，缺省为 `http://127.0.0.1:3000`。`vite preview` 使用端口 4173 和同一代理。API 对 POST 校验 Origin，因此 `BETTER_AUTH_TRUSTED_ORIGINS` 必须包含 Web 的 Origin，例如 `http://127.0.0.1:3000,http://127.0.0.1:5173,http://127.0.0.1:4173`。

客户门户登录页为 `/login`，首页为 `/`。管理后台登录页为 `/admin/login`，首页为 `/admin`。

## 命令

| 命令                                 | 作用                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm check`                         | lint、格式、全部 typecheck、根 Vitest 与 Web Vitest，最后构建 Web                                    |
| `pnpm test`                          | 根 Vitest，然后运行 `apps/web` 的 Vitest（jsdom）                                                    |
| `pnpm test:e2e`                      | 在 `apps/web/e2e` 运行 Playwright，启动真实 API 和 `vite build && vite preview`，连接真实 PostgreSQL |
| `pnpm screenshots`                   | 截取实现与设计稿画框，写入 `docs/evidence/phase-4-web/screenshots/`                                  |
| `pnpm --filter @fs-billing/web lint` | 只检查 Web 包                                                                                        |

`test:e2e` 与 `screenshots` 需要已迁移并写入种子的数据库，以及环境变量 `DATABASE_URL`、`APP_DATABASE_URL`、`AUTH_DATABASE_URL` 和 `SEED_AUTH_PASSWORD`。Playwright 会读取根目录 `.env`，已有环境变量优先。global setup 运行幂等的 `auth:seed`，并清除种子账号的锁定计数。`auth:seed` 不覆盖已有密码，因此 `SEED_AUTH_PASSWORD` 必须与首次初始化时一致。`BETTER_AUTH_SECRET` 未设置时每次运行随机生成。首次运行前执行 `pnpm --filter @fs-billing/web exec playwright install chromium`。

测试共享数据库、锁定计数和每 IP 每分钟 30 次的登录限流，所以 Playwright 只用一个 worker。一次 e2e 约登录 20 次，连续运行 e2e 和截图可能接近限流；遇到 `RATE_LIMITED` 时等待一分钟再运行。

CI 新增 `web-e2e` job：安装 Chromium，启动 PostgreSQL，迁移和写入种子，然后运行 `pnpm test:e2e`。失败时上传 Playwright 报告。原 `check` job 通过 `pnpm check` 运行 Web 的 typecheck、测试和构建。`freeswitch.yml` 未改动。

## 结构

- `src/lib/api.ts` 按 `@fs-billing/shared` 的 `apiContract` 发请求。成功响应用契约 schema 解析，错误响应用 `apiErrorSchema` 解析。Web 不重复定义契约类型。
- `src/lib/zone.ts` 定义门户和后台两个区域：首页、登录页和身份类型。
- `src/lib/session.ts` 把 `/api/auth/session` 的结果表示为 `active`、`signed-out` 或 `blocked` 三种状态，并保存页面内“登录已过期”的状态。
- `src/lib/return-to.ts` 在 `sessionStorage` 保存返回路径，登录后按身份校验。
- `src/lib/login-errors.ts` 把登录错误代码映射为页面状态和中文文案。
- `src/lib/format.ts` 与 `src/components/data-format.tsx` 提供金额、费率和时间格式。`src/components/status-tag.tsx` 提供状态标签。
- `src/router.tsx` 使用 TanStack Router 代码路由。受保护区域在 `beforeLoad` 中确认会话。

## 决定

**会话过期。** 进入受保护区域时，路由每次请求 `/api/auth/session`。返回 401 `reauthenticate` 时，保存当前路径和 query，直接跳到该区域的登录页。只有 `SESSION_EXPIRED` 才显示顶部“登录已过期”提示，因为 `UNAUTHENTICATED` 也可能是首次访问。页面内请求返回 401 `reauthenticate` 时，按设计稿 3c/3d 弹出不可关闭的对话框。点击“重新登录”后保存路径，进入带提示的登录页。登录成功后返回保存的路径。`INVALID_CREDENTIALS` 和 403 不触发重新登录。

**返回路径校验。** 路径必须以单个 `/` 开头，不能含反斜杠或控制字符，必须属于登录身份的区域，且不能是登录页。不满足时回到身份首页。返回路径只存在浏览器本地，不发给 API。

**错误身份类型。** 登录成功后由响应的 `identity.kind` 决定区域，与使用哪个登录页无关。客户在后台登录页登录后进入门户。已登录用户访问另一区域时，跳转到自己的首页。

**停用和身份不可用。** 会话或上下文接口返回 `ACCOUNT_DISABLED` 或 `IDENTITY_UNAVAILABLE` 时，清除外壳，只显示提示和“退出登录”，不自动重新登录。

**退出。** 调用 logout 后清空查询缓存并进入该区域登录页。会话已失效返回 401 时同样视为已退出。

**金额与费率。** 金额来自 API 的十进制字符串，用 decimal.js 按 `ROUND_HALF_UP` 保留 2 位，与 `packages/rating` 的 `toFixed(2, ROUND_HALF_UP)` 一致。负号在币种符号前，例如 `-35.2` CNY 显示为 `-¥35.20`，USD 使用 `$`。四舍五入为零的负数显示为 `¥0.00`，不显示负号。费率固定 4 位小数，带单位时 CNY 为 `0.0450 元/分钟`，USD 为 `$0.0120/分钟`。`apps/web/src` 已纳入 `money/no-number-money` lint 规则。

**时间。** 所有时间按北京时间（UTC+8，无夏令时）显示为 `YYYY-MM-DD HH:mm:ss`，月份为 `YYYY年M月`，时长为 `3分50秒`。锁定倒计时使用同一时长格式。

**主题。** 偏好存于 `localStorage` 的 `fs-billing.theme`，取值为浅色、深色或跟随系统，缺省跟随系统。`index.html` 的首屏脚本在渲染前设置 `data-theme` 和 `data-product`，避免闪烁。门户使用中性主色，后台使用蓝色主色，由 `data-product` 切换。

**响应式。** 登录页在 640px 以下使用手机布局，外壳在 768px 以下使用手机顶栏、抽屉导航和底部账号面板。

**组件。** UI 基础组件按 shadcn/ui 方式写在仓库内（Tailwind v4 + class-variance-authority），下拉菜单和对话框使用 Radix。颜色令牌取自设计稿的 CSS 变量，并通过 Tailwind `@theme` 暴露。

## 与设计稿的差异

截图位于 `docs/evidence/phase-4-web/screenshots/`。`design-*.png` 为设计稿画框，`app-*.png` 为实现，`compare-*.png` 左侧为设计稿、右侧为实现。页面为 customer-login、admin-login、customer-404、admin-404，各有 light、dark 和 mobile。电脑截图使用设计画框的尺寸（登录 960×640，404 为 1200×560）。手机截图使用 375×812，设计稿手机画框为 390 宽并包含 44px 状态栏。

- 手机设计稿的状态栏（9:41）和圆角机身属于画框，不实现。
- 外壳导航只有“首页”或“概览”。设计稿中的话单、月账单、余额流水、租户等页面属于阶段 5 至 8，现在加入会指向 404。
- 设计稿中门户账号菜单有“账号设置”。修改密码页属于阶段 6，本阶段不显示该项。
- 门户 404 设计稿的顶栏只显示头像。实现与门户账号菜单画框（3a）一致，显示 ◐、头像和邮箱。
- 设计稿手机画框没有主题入口（门户主题在阶段 6 的账号设置页）。实现在手机账号面板中加入浅色、深色、跟随系统的分段选择，样式取自账号设置的“主题”卡片。
- 后台侧栏的“系统告警”红点依赖阶段 8 的告警数据，本阶段不显示。
- 字体使用系统字体栈，截图环境为 Linux 的 Noto Sans CJK，与设计稿渲染环境一致。苹方等字体在 macOS 上的字形会不同。
- 构建产物为单个约 600 kB（gzip 约 190 kB）的 JS 文件，Vite 会给出体积提示。后续页面增加后再按路由拆分。

## 设计稿未覆盖的文案

以下状态在第三批设计稿中没有画框，按相邻文案的写法补充。

| 状态                           | 标题                 | 说明                                             |
| ------------------------------ | -------------------- | ------------------------------------------------ |
| `IDENTITY_UNAVAILABLE`         | 该账号暂时无法使用   | 门户：请联系客服处理；后台：请联系其他管理员处理 |
| `RATE_LIMITED`                 | 请求过于频繁         | 请在 M分SS秒 后重试                              |
| 网络错误、503、500、Origin 403 | 暂时无法登录         | 服务暂时不可用，请稍后重试                       |
| 已登录后资料停用（外壳内）     | 与登录页停用文案相同 | 只提供“退出登录”                                 |
| 路由加载失败                   | 加载失败             | 网络异常，请稍后重试（取自设计系统空状态）       |

## 待用户决定

无。设计稿与 plan.md 没有需要产品决定的冲突。上表补充的文案可在评审时调整，不影响结构。

## 测试证据

- `apps/web/src/lib/format.test.ts`：`-35.2` CNY 为 `-¥35.20`，USD 使用 `$`，千分位、四舍五入、负零，费率 4 位小数与单位，北京时间跨日、月份与时长。
- `apps/web/src/lib/login-errors.test.ts`：未知邮箱与密码错误同一文案，停用、身份不可用、锁定倒计时、限流和服务不可用。
- `apps/web/src/lib/return-to.test.ts`：同区域路径保留 query 和 hash，拒绝外站、`//`、反斜杠、控制字符、其他区域和登录页。
- `apps/web/src/app.test.tsx`：在内存路由中渲染完整应用，验证页面内 401 弹窗、重新登录后回到原页面并显示 `-¥35.20`，未登录跳转，403 不重新登录，停用页面，锁定倒计时，登录响应决定区域，404。
- `apps/web/e2e/auth.spec.ts`：连接真实 API 与 PostgreSQL，共 14 个场景。客户进入门户并显示种子余额 `-¥35.20`，USD 客户显示 `-$15.02`，管理员进入后台，错误登录页仍按身份进入区域，删除 cookie 和数据库撤销会话后重新登录并回到原页面，其他区域返回路径被拒绝，404，连续失败锁定并显示倒计时，未知邮箱与错误密码响应相同，停用账号，账号菜单退出，主题持久化，375px 手机登录、账号面板切换主题和退出。
