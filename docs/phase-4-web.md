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

测试共享数据库和账户锁定计数，所以 Playwright 只用一个 worker。`apiEnvironment()` 显式设置 `NODE_ENV=test`、`FSB_ALLOW_TEST_OVERRIDES=1` 和 `AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX=10000`，提高共用回环 IP 的凭据请求上限，时间窗口仍为一分钟。未设置覆盖值时 API 默认上限为每 IP 每分钟 30 次。覆盖值只允许在两个开关同时满足时使用，否则 API 启动失败。复用已有 API 时不会重新应用这些环境变量。e2e 沿用 HTTP cookie 和 API 日志行为；Better Auth 的 Origin 和 CSRF 校验显式保持开启，详见 [API 设计](phase-4-api-design.md)。

CI 新增 `web-e2e` job：安装 Chromium，启动 PostgreSQL，迁移和写入种子，然后运行 `pnpm test:e2e`。失败时上传 Playwright 报告。原 `check` job 通过 `pnpm check` 运行 Web 的 typecheck、测试和构建。`freeswitch.yml` 未改动。

## 结构

- `src/lib/api.ts` 按 `@fs-billing/shared` 的 `apiContract` 发请求。成功响应用契约 schema 解析，错误响应用 `apiErrorSchema` 解析。Web 不重复定义契约类型。
- `src/lib/zone.ts` 定义门户和后台两个区域：首页、登录页和身份类型。
- `src/lib/session.ts` 把 `/api/auth/session` 的结果表示为 `active`、`signed-out` 或 `blocked` 三种状态，并保存页面内“登录已过期”的状态。
- `src/lib/return-to.ts` 在 `sessionStorage` 保存返回路径（不可用时退回内存），登录后用应用路由器的匹配结果按身份校验。
- `src/lib/login-errors.ts` 把登录错误代码映射为页面状态和中文文案。
- `src/lib/format.ts` 与 `src/components/data-format.tsx` 提供金额、费率和时间格式。`src/components/status-tag.tsx` 提供状态标签。
- `src/router.tsx` 使用 TanStack Router 代码路由。受保护区域在 `beforeLoad` 中确认会话。

## 决定

**会话过期。** 进入受保护区域时，路由每次请求 `/api/auth/session`。返回 401 `reauthenticate` 时，保存当前路径和 query，直接跳到该区域的登录页。只有 `SESSION_EXPIRED` 才显示顶部“登录已过期”提示，因为 `UNAUTHENTICATED` 也可能是首次访问。页面内请求返回 401 `reauthenticate` 时，按设计稿 3c/3d 弹出不可关闭的对话框。点击“重新登录”后保存路径，进入带提示的登录页。登录成功后返回保存的路径。`INVALID_CREDENTIALS` 和 403 不触发重新登录。

**返回路径校验。** 路径必须以单个 `/` 开头，不能含反斜杠或控制字符。去掉 `..` 等点段后仍须以单个 `/` 开头。区域和登录页由应用路由器自己的匹配结果判断，与实际渲染的页面一致：路由器会解码 `%6c` 这类转义、忽略大小写、接受末尾斜杠，因此 `/login/`、`/%6cogin`、`/%61dmin` 都按登录页或后台处理。路径必须属于登录身份的区域，且不能是登录页。不满足时回到身份首页。返回路径只存在浏览器本地，不发给 API。`sessionStorage` 被禁用或读写抛错时，路径保存在本页内存中，登录流程不受影响。

**错误身份类型。** 登录成功后由响应的 `identity.kind` 决定区域，与使用哪个登录页无关。客户在后台登录页登录后进入门户。已登录用户访问另一区域时，跳转到自己的首页。

**停用和身份不可用。** 会话或上下文接口返回 `ACCOUNT_DISABLED` 或 `IDENTITY_UNAVAILABLE` 时，清除外壳，只显示提示和“退出登录”，不自动重新登录。

**退出。** logout 成功后才清空查询缓存并进入该区域登录页。会话已失效返回 401 时同样视为已退出。网络错误、403、429、5xx 时保留当前会话和页面，在退出按钮旁显示“退出失败，请检查网络后重试”，再次点击即重试。电脑版账号菜单在失败时保持打开。

**首页加载失败。** 首页上下文请求失败时不再停在骨架屏。403 显示“没有权限查看”，不提供重试。其他 4xx 说明请求无法完成。网络错误和 5xx 在查询自动重试两次后显示“加载失败”和“重试”按钮。401 `reauthenticate` 仍由登录过期对话框处理。

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
- 设计稿手机画框没有主题入口（门户主题在阶段 6 的账号设置页）。实现在手机账号面板中加入浅色、深色、跟随系统的分段选择，样式取自账号设置的“主题”卡片。分段选择使用原生单选框，整组只占一个 Tab 停靠点，方向键切换。
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
| 首页上下文 403                 | 没有权限查看         | 当前账号无权查看此内容，如有疑问请联系管理员     |
| 首页上下文其他 4xx             | 加载失败             | 请求无法完成，请刷新页面或联系管理员             |
| 退出失败                       | （无标题）           | 退出失败，请检查网络后重试                       |

## 待用户决定

无。设计稿与 plan.md 没有需要产品决定的冲突。上表补充的文案可在评审时调整，不影响结构。

## 测试证据

- `apps/web/src/lib/format.test.ts`：`-35.2` CNY 为 `-¥35.20`，USD 使用 `$`，千分位、四舍五入、负零，费率 4 位小数与单位，北京时间跨日、月份与时长。
- `apps/web/src/lib/login-errors.test.ts`：未知邮箱与密码错误同一文案，停用、身份不可用、锁定倒计时、限流和服务不可用。
- `apps/web/src/lib/return-to.test.ts`：同区域路径保留 query 和 hash，拒绝外站、`//`、反斜杠、控制字符、其他区域和登录页，包括 `/login/`、`/%6cogin`、`/LOGIN`、`/%61dmin`、`/admin/login/` 和点段归一化后的 `//evil.example`。`sessionStorage` 抛错或不可用时从内存取回路径；写入失败但读取成功时，以本次内存中的路径为准，不用存储中的旧路径。
- `apps/web/src/components/theme-controls.test.tsx`：手机主题分段选择只占一个 Tab 停靠点，方向键切换并应用主题。
- `apps/web/src/app.test.tsx`：在内存路由中渲染完整应用，验证页面内 401 弹窗、重新登录后回到原页面并显示 `-¥35.20`，未登录跳转，403 显示无权限提示且不重新登录，首页 503 与网络错误显示可重试的错误并能恢复，`sessionStorage` 不可用时过期跳转和登录后返回仍正常，退出失败（503、429、网络错误）保留会话并可重试，退出时 401 视为已退出，停用页面，锁定倒计时，登录响应决定区域，404。
- `apps/web/e2e/auth.spec.ts`：连接真实 API 与 PostgreSQL，共 16 个场景。客户进入门户并显示种子余额 `-¥35.20`，USD 客户显示 `-$15.02`，管理员进入后台，错误登录页仍按身份进入区域，删除 cookie 和数据库撤销会话后重新登录并回到原页面，其他区域返回路径被拒绝，404，连续失败锁定并显示倒计时，未知邮箱与错误密码响应相同，停用账号，账号菜单退出，退出接口 503 时留在原页面、显示错误并可重试，首页上下文 403 显示无权限提示，主题持久化且显式浅色或深色不随系统变化、跟随系统随 `emulateMedia` 变化，375px 手机登录、账号面板用鼠标和方向键切换主题、Tab 离开分组后退出。

## Codex review 1 resolution

每项都有行为测试；修复前运行新测试，除“退出时 401 视为已退出”（原行为正确，作为回归保护）外均失败。

- **阻塞：失败的退出被当作已退出。** `use-logout.ts` 把清缓存和跳转从 `onSettled` 移到 `onSuccess`，401 仍视为已退出。账号菜单、手机账号面板和停用页在失败时显示“退出失败，请检查网络后重试”，可再次点击重试。测试：`app.test.tsx` 的 `logout` 组（503 后重试成功、网络错误时菜单保持打开、429 留在停用页、401 进入登录页），e2e“a failed logout keeps the session and offers a retry”（503 后仍在 `/`，恢复接口后退出，再访问 `/` 回到登录页）。
- **应修复：首页错误后停在骨架屏。** 新增 `components/load-error.tsx`，`home.tsx` 在门户和后台上下文失败时显示错误：403 无重试，其他 4xx 无重试，网络错误和 5xx 有重试。`app.test.tsx` 的 403 用例现在先等到无权限提示出现，再断言没有重新登录对话框。另有 503 重试恢复和后台网络错误用例，以及 e2e 403 用例。
- **应修复：存储失败打断认证。** `return-to.ts` 对取得 `sessionStorage` 和每次读写分别捕获异常，同时保存在内存中，读取失败时用内存路径，最终由 `resolveReturnPath` 回到身份首页。测试覆盖过期跳转时存储不可用、登录成功时 `getItem` 抛错。
- **应修复：单选组缺少键盘行为。** `ThemeSegmented` 改为原生单选框，样式用 `has-checked:` 和 `has-focus-visible:`。`theme-controls.test.tsx` 验证单个 Tab 停靠点和方向键切换，e2e 手机用例在真实 Chromium 中用方向键和 Tab 验证。
- **小问题：返回路径与路由器匹配规则不一致。** `resolveReturnPath` 接收应用路由器，用 `parseLocation` 和 `matchRoutes` 判断区域和登录页，不再自行比较路径字符串。点段归一化后再次检查开头的 `//`。`/a/../%2fevil.example` 归一化为同源路径 `/%2fevil.example`，路由器不解码 `%2f`，结果是门户 404，测试按此记录。
- **小问题：e2e 依赖响应后立即读取文字。** `helpers.ts` 新增 `errorCode` 和 `expectSettledAlert`。连续登录用例先按本次响应的状态码和错误代码分支，再等登录按钮恢复可用、提示出现预期文字后才提交下一次。
- **小问题：“跟随系统”未断言结果。** e2e 主题用例在显式深色、浅色下切换 `emulateMedia`，断言主题不变；在跟随系统下切换，断言主题随之变化并在刷新后保持。手机用例也在跟随系统下切换 `emulateMedia`。

`pnpm check` 与 `pnpm test:e2e`（16 个场景）通过。`pnpm screenshots` 已重新运行；截图页面（登录页、404）没有变化。

## Codex review 2

结论：APPROVE，无阻塞、无应修复项，记录见 [codex-review-2.log](evidence/phase-4-web/codex-review-2.log)。review 1 的七项均已确认修复。

- **小问题：存储中的旧路径覆盖本次路径。** `setItem` 失败而 `getItem` 成功时，`takeReturnPath` 返回 `sessionStorage` 中上一次保存的路径，而不是本次过期时记下的路径。已改为优先使用内存路径（`remembered ?? stored`），只有页面重新加载、内存为空时才读存储。`return-to.test.ts` 新增“写入失败、读取返回旧路径”用例，修复前失败，修复后通过。

`pnpm check` 通过。Bot 已验证 `pnpm check`、`pnpm test:e2e` 16 个场景通过，CI `check` 与 `web-e2e` 均为绿色。
