# 阶段 4 后端设计

分支：`phase-4-api`。本文对应 [plan.md 阶段 4](plan.md) 的后端范围。共享契约、数据库迁移、API 服务、行为测试与 CI 均已实施。PostgreSQL 验收和隔离变异证明须由 Bot 执行，不能将实现状态当作验收通过。

## 1. 现有结构与范围

已核对 `apps/api/src/app.ts`、`main.ts`、`app.test.ts`，`packages/shared/src/index.ts`、`worker.ts`，`packages/db/src/client.ts`、`schema.ts`、`seed.ts`、迁移 `0000` 至 `0004`、数据库测试，以及 `apps/worker` 的应用工厂、配置、事务和生命周期模式。

- API 目前只有 `/api/health`，没有认证、数据库依赖或 OpenAPI。Worker 的应用工厂注入依赖，入口负责连接与关闭资源，API 沿用这一边界。
- 共享包已有 Zod 数据格式。锁文件解析为 Fastify `5.12.5`、Zod `4.6.6`、Drizzle `0.45.4`。新的浏览器契约不得引入数据库、Fastify 或 Better Auth 类型。
- 数据库 SQL 是结构权威，Drizzle 是查询描述。迁移 journal 当前最后一项为 `0004_billing_number_not_null`，新增迁移继续追加，不改历史。
- `withTenant` 在同一事务中设置 `app.scope='tenant'` 和 `app.tenant_id`，客户只读。`withAdmin` 设置管理员范围。未设置身份默认读不到业务行。应用连接必须是 `fs_billing_app`，不能用 owner。
- `admins` 目前只有管理员范围可读，`portal_accounts` 受租户 RLS 限制。因此登录后不能直接用普通连接查资料表，也不能先使用请求中的租户编号解决这个问题。
- Worker 继续持有内网 FreeSWITCH 接口及后台任务。API 不导入 Worker，也不新增计费算法、业务锁或分区维护路径。

阶段 4 实现真实登录、会话、身份上下文、管理员权限边界及隔离测试。租户 CRUD、充值、费率、话单列表、月账单和 CSV 功能分别留给后续阶段。至少提供一个真实数据库客户读端点，避免以空集合证明隔离。

依据 [阶段 2 的认证决定](phase-2-db.md) 与 [design.md §10、§11](design.md)，邮箱只有认证表一个来源，身份类型由资料表决定，客户租户只来自已验证会话对应的资料。

实施顺序见 §10。§11 记录最终决定，不再保留待选认证方案。

## 2. 调用方式先于实现

Web 从 `@fs-billing/shared` 导入 `apiContract`、`identitySchema` 和 `apiErrorSchema`。登录请求不带身份或租户参数，成功响应中的 `identity.kind` 决定进入门户还是后台。

```text
POST /api/auth/login  { email, password }
200 { identity: { kind: "customer", profileId, email, tenant: { id, code, name, currency } }, expiresAt }
Set-Cookie: ...; HttpOnly; Secure; SameSite=Lax

GET /api/portal/context  Cookie: 有效客户会话
200 { identity: 客户身份, balance: { currency: "CNY", amount: "-35.20" } }

GET /api/admin/context  Cookie: 客户会话
403 { error: { code: "FORBIDDEN", message: "需要管理员权限", requestId } }

GET /api/portal/context  Cookie: 已过期会话
401 { error: { code: "SESSION_EXPIRED", message: "登录已过期", requestId, action: "reauthenticate" } }
```

业务端点的缺失会话返回 `UNAUTHENTICATED`。过期或已撤销且服务器能确认失效原因的会话返回 `SESSION_EXPIRED`。若会话行已清理，或浏览器因 cookie 到期不再发送 token，服务器无法可靠区分首次访问与过期，返回 `UNAUTHENTICATED`。两个代码均带 `action: 'reauthenticate'`，前端采用相同的跳转并返回流程。

前端在本地保存当前站内路径和 query，去相应登录页，成功后按身份校验该路径再返回。API 不回显任意 `returnTo`，不将它放入认证 session。拒绝协议、`//` 开头或不同身份区域的返回路径，默认回身份首页。401 登录失败 `INVALID_CREDENTIALS` 不触发重复跳转。403 不触发重新登录。后端提供契约与行为证据，浏览器回到原页面的完整证据由阶段 4 前端测试提供。

## 3. 数据形状与共享契约

先交付 `packages/shared` 的浏览器契约与测试，再实现 API。以下展示浏览器数据形状与后续 API 内部签名。共享契约由本次步骤 2 实现，API 内部类型仍属后续实现。

```ts
type Identity =
  | {
      kind: 'admin';
      profileId: string;
      name: string;
      email: string;
    }
  | {
      kind: 'customer';
      profileId: string;
      email: string;
      tenant: {
        id: string;
        code: string;
        name: string;
        currency: 'CNY' | 'USD';
      };
    };

type Principal =
  | { kind: 'admin'; authUserId: AuthUserId; profileId: AdminId }
  | {
      kind: 'customer';
      authUserId: AuthUserId;
      profileId: PortalAccountId;
      tenantId: TenantId;
    };

type RouteAccess =
  'public' | 'session' | 'authenticated' | 'customer' | 'admin';
type ApiDependencies = { businessDb: Db; auth: AuthGateway; logger?: boolean };
function createApi(deps: ApiDependencies): FastifyInstance;
function resolvePrincipal(userId: AuthUserId): Promise<Principal>;
function readPortalContext(
  tx: Tx,
  principal: CustomerPrincipal,
): Promise<PortalContext>;
```

`Identity` 是浏览器可见的 Zod 联合，类型从 schema 推导，不包含 `authUserId`。`Principal` 是 API 内部联合，经过认证与资料映射后才能构造。客户分支必须有 `tenantId`，管理员分支没有；不使用 `isAdmin` 加可选租户。内部品牌类型在解析边界构造，不将 UUID 断言散到 handler。认证用户 ID 暂按非空字符串设计，最终 SQL 类型与安装版本生成的结构一致，不能假定 Better Auth 默认生成 UUID。

| Schema                        | 约束与职责                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identitySchema`              | `z.discriminatedUnion('kind', ...)`，管理员与客户互斥。邮箱来自 `auth` 用户表，资料表只提供业务身份。                                                                                                          |
| `loginRequestSchema`          | `z.strictObject({ email: z.email(), password: z.string().min(1) })`，登录不能用“新密码至少 8 位”的规则拒绝既有凭据。                                                                                           |
| `newPasswordSchema`           | 新密码 8 至 128 位。Better Auth 配置使用同一范围，密码不 trim，不记录日志。                                                                                                                                    |
| `changePasswordRequestSchema` | 当前密码、新密码，成功撤销其他设备会话。确认密码属前端输入校验，不作为独立后端状态。                                                                                                                           |
| `sessionResponseSchema`       | `{ identity, expiresAt: z.iso.datetime() }`，禁止把 session token 或密码哈希输出到 JSON。                                                                                                                      |
| `moneySchema`                 | `{ currency: z.enum(['CNY','USD']), amount: 只可带可选负号的普通十进制字符串 }`，最多 128 个字符，禁止负零、正号、整数前导零、指数格式、空白及 JS number，保留原始精度。显示 2 位、费率 4 位留给前端格式组件。 |
| `portalContextResponseSchema` | 身份及该租户余额，来自真实数据库行，输出显式投影。                                                                                                                                                             |
| `apiErrorSchema`              | 按 `error.code` 判别的联合，HTTP 状态与代码对应。不得只用任意字符串 error。                                                                                                                                    |
| `apiContract`                 | 每个 operation 的稳定 `operationId`、method、path、access、Zod 请求与各状态响应、隔离测试类别。唯一清单。                                                                                                      |

`apiContract.request` 分别给出 params、query 和 body schema。无参数或 query 使用严格空对象。无请求 body 使用 `z.strictObject({}).optional()`，接受不发送 body 或发送 `{}`，拒绝额外字段。logout、撤销其他会话与两条重置 POST 均采用这一规则。不发送 body 时不需要 Content-Type，客户端应省略它，避免 Fastify 拒绝空 JSON body。发送 `{}` 时使用 `Content-Type: application/json`。204 响应使用 `z.undefined()` 表示没有响应体。调用身份从 access 推导，public 对应 public，session 与 authenticated 均对应 customer 与 admin，其余分别对应同名身份，不保存冗余 audience 字段。session 仅要求有效 Better Auth session，资料停用、缺失或歧义时仍可调用；authenticated 还要求成功解析启用的业务资料与租户。

响应 schema 使用严格对象。API 与 Web 一起部署，不支持分别升级的契约版本。已有浏览器页面在版本切换后需要重新加载，前端部署处理旧 bundle 的更新，不假设严格解析可容忍新字段。

logout 使用 access=session，只验证有效 Better Auth session，不调用资料解析器，不检查账号或租户状态，不因资料状态返回 403。和所有 cookie 写操作一样，不可信 Origin 返回 403 FORBIDDEN，契约仅为该 CSRF 边界声明 403，不能返回 ACCOUNT_DISABLED 或 IDENTITY_UNAVAILABLE。即使资料停用、缺失或歧义，也撤销当前 session 并清除 cookie。session 端点及其他需解析身份的受保护路由每次核对资料与租户状态，停用返回 403 ACCOUNT_DISABLED。前端清除缓存身份和受保护数据，显示账号停用页面并提供退出按钮，不自动重登；退出调用 logout，成功后进入登录页。401 仍按 §2 重新认证。IDENTITY_UNAVAILABLE 同样显示无法使用身份的提示并允许退出。

客户 query、params、body 中不声明 `tenantId`、`tenant_id`、`tenant` 或身份覆盖字段。严格 Zod 对象拒绝额外字段。Header 中的租户编号和客户端角色不能参与派生，测试验证伪造 header 不改变结果。未来客户资源 ID 只定位资源，不能决定 tenant。请求边界解析、响应序列化和 OpenAPI 转换使用同一组 schema。

`errors.ts` 的定义表集中声明每个 code、HTTP 状态和附加字段，错误联合、各 code 响应 schema 与状态表均从该表生成。

错误统一为 `{ error: { code, message, requestId, ...该代码专属字段 } }`，message 用中文，前端以 code 分支。

| HTTP | 代码                                       | 附加字段与行为                                                              |
| ---- | ------------------------------------------ | --------------------------------------------------------------------------- |
| 400  | `VALIDATION_ERROR`                         | `issues: [{ path: (string                                                   | number)[], message }]`，不回显密码值。 |
| 401  | `UNAUTHENTICATED`、`SESSION_EXPIRED`       | `action: 'reauthenticate'`，`Cache-Control: no-store`。                     |
| 401  | `INVALID_CREDENTIALS`                      | 统一“账号或密码错误”，不区分邮箱不存在和密码错误。                          |
| 403  | `FORBIDDEN`                                | 有效会话但身份不符，权限判断先于管理业务数据访问。                          |
| 403  | `ACCOUNT_DISABLED`、`IDENTITY_UNAVAILABLE` | 资料停用，或 0 个、2 个资料匹配。失败关闭，不任选一张表。                   |
| 404  | `NOT_FOUND`                                | 自己不存在与别人的资源使用同一外部响应，不暴露存在性。                      |
| 429  | `ACCOUNT_LOCKED`                           | 返回 `retryAfterSeconds`、`Retry-After`，语义为连续失败规则。               |
| 429  | `RATE_LIMITED`                             | 请求限流，独立于账户锁定，返回正整数 `retryAfterSeconds` 与 `Retry-After`。 |
| 503  | `SERVICE_UNAVAILABLE`                      | 认证或数据库不可用，保留 requestId，不泄露驱动错误。                        |
| 500  | `INTERNAL_ERROR`                           | 记录内部错误，外部只返回通用消息。                                          |

第一批 operation 包含登录、退出、读取 session、改密码、撤销其他会话、`portalContext`、`adminContext` 和 health。管理员重置密码的两条独立后端操作契约一并交付，不提前实现阶段 5 开户或阶段 9 的完整账号管理页面。登录成功只按真实资料决定区域，无公开注册端点。Better Auth 原始管理路由与注册路由不作为通配入口公开。

| operationId                  | Method 与 path                                        | 调用身份（由 access 推导） | access        | 成功响应                            |
| ---------------------------- | ----------------------------------------------------- | -------------------------- | ------------- | ----------------------------------- |
| `health`                     | GET `/api/health`                                     | public                     | public        | 200，现有健康 schema                |
| `login`                      | POST `/api/auth/login`                                | public                     | public        | 200，session schema 及 cookie       |
| `logout`                     | POST `/api/auth/logout`                               | customer、admin            | session       | 204，清除当前 cookie                |
| `session`                    | GET `/api/auth/session`                               | customer、admin            | authenticated | 200，session schema                 |
| `changePassword`             | POST `/api/auth/change-password`                      | customer、admin            | authenticated | 200，session schema 及新 cookie     |
| `revokeOtherSessions`        | POST `/api/auth/revoke-other-sessions`                | customer、admin            | authenticated | 204，保留当前会话                   |
| `portalContext`              | GET `/api/portal/context`                             | customer                   | customer      | 200，portal context schema          |
| `adminContext`               | GET `/api/admin/context`                              | admin                      | admin         | 200，管理员 identity schema         |
| `resetPortalAccountPassword` | POST `/api/admin/portal-accounts/{id}/reset-password` | admin                      | admin         | 200，临时密码，只响应一次，no-store |
| `resetAdminPassword`         | POST `/api/admin/admins/{id}/reset-password`          | admin                      | admin         | 200，临时密码，只响应一次，no-store |

重置目标用资料 ID 定位，由管理员边界解析到 authUserId，不接受请求中的 role 作为授权。管理员不能通过管理员重置路由重置自己，返回 403 FORBIDDEN，使用 change-password 修改自己的密码。服务器使用 `crypto.randomBytes` 生成满足 8 至 128 位约束的临时密码，使用 Better Auth 上下文哈希。原子重置、撤销和竞态规则见 §11。所有 cookie 认证的写操作检查可信 Origin 与同域来源，保留 Better Auth 的 CSRF 防护，不能因服务端包装就跳过。设置日志字段脱敏，成功响应与错误响应都不得记录密码、cookie 或 Authorization。

## 4. 模块布局与结构选择

共享契约目录由本次步骤 2 实现。以下 DB 和 API 文件均为后续步骤拟新增或修改的文件。

```text
packages/shared/src/api/
  identity.ts          浏览器身份联合，不含 authUserId
  money.ts             币种与保留精度的十进制字符串
  errors.ts            错误联合与状态对应
  auth.ts              登录、会话、密码操作 schemas
  context.ts           门户与后台上下文 schemas
  contract.ts          operation 契约及隔离测试类别
  index.ts             浏览器契约出口
packages/shared/src/health.ts      现有健康 schema，避免契约与根出口循环引用
packages/shared/src/index.ts       导出新契约，保留现有 Worker 契约
packages/db/
  migrations/0005_auth.sql         auth 表、角色、资料关联、受限身份解析函数
  migrations/meta/_journal.json    追加迁移记录
  src/auth-schema.ts              auth 结构描述，按实际版本生成结果核对
  src/schema.ts                   删除资料 email，增加 authUserId
  src/identity.ts                 调用受限 DB 函数，解析结果
  src/migrate.ts                  配置 auth 角色密码，仍只在部署迁移入口执行
  src/seed.ts                     认证用户与资料种子，保留业务主键
  test/support.ts、global-setup.ts auth 连接与种子引用适配
apps/api/src/
  app.ts、main.ts、config.ts       工厂、连接生命周期、环境解析
  auth/gateway.ts                 隔离 Better Auth API、cookie、错误适配
  auth/better-auth.ts             版本固定的认证实例与 auth 专用连接
  identity.ts                    验证 session 后派生 Principal
  routes/register.ts             从契约注册 schema、权限、handler
  routes/auth.ts                 登录、会话及凭据操作
  routes/portal.ts、admin.ts       Fastify 封装插件，内部只使用事务 tx
  errors.ts、openapi.ts            错误适配与运行中实例的 OpenAPI 输出
  scripts/export-openapi.ts        app.ready() 后导出文档
  scripts/unlock-account.ts        使用 owner 凭据的紧急解锁 CLI
  test/idor-cases.ts               operationId 对应的行为场景，不能默默跳过
  auth.db.test.ts、idor.db.test.ts  真 cookie、两租户、两个实际运行角色
  tenant-filter-mutation.db.test.ts 应用过滤与 RLS 的独立证明
packages/db/src/auth.db.test.ts    schema、权限、资料映射、迁移测试
```

方案 A 以共享契约注册器集中 access、schema 和 operationId，运行时 handler 按功能分组。方案 B 由 Fastify 功能插件各自声明路由与权限，只把 Zod DTO 放在共享包，再从 Fastify 导出 OpenAPI。A 的优势是新端点必须给出权限与契约，前端可先拿契约；B 的优势是局部插件更直观，但容易出现遗漏 metadata 或未公开的路由。

选择 A 为基础，吸收 B 的 Fastify 封装方式。注册器只统一传输与权限边界，不做通用 repository、service、controller 多层转发。客户插件给 handler 的输入只有客户 Principal 和 `Tx`，数据库连接池不作为 handler 参数。管理员插件同理。契约与实际注册路由集合必须相等。测试 case 清单若与契约不同立即失败，不能使用默认空 case。

小型注册边界集中声明权限并生成覆盖清单，避免多层接口转发与手工维护重复清单。认证用户的双资料表映射通过受限函数解析，不放进 cookie metadata，也不向身份解析器开放管理员业务查询能力。

## 5. Better Auth 版本与能力核验

早期设计时 sandbox 无法取得 registry 包。此后 Bot 已安装并锁定 Better Auth 1.7.7，依赖及 integrity 已固定于 `pnpm-lock.yaml`，实际安装源码核验见 §12.1。

网络工具可以读取官方版本标签源码，因此固定采用精确版本 **`better-auth@1.7.7`**，不使用浮动 latest 或范围。[该标签 package.json](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/package.json) 的 version 是 `1.7.7`。以下保留设计时的标签源码核验，实际安装 `dist` 与行为验证已完成，见 §12.1 和 §12.3。不声明它是最新版本，不自动换版本。

| 要求                             | 固定版本 1.7.7 的分类                                                         | 源码证据与限制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 连续失败 5 次锁定账户 15 分钟    | **NOT supported**，原生及已核对的内置限流、admin 插件不提供该账户连续失败语义 | [sign-in.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/api/routes/sign-in.ts) 验证邮箱与密码，失败返回 `INVALID_EMAIL_OR_PASSWORD`，没有连续失败计数或锁定期限。[rate-limit/index.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/api/rate-limiter/index.ts) 按 IP 与路径在请求结果之前计数，不能替代按账户的失败计数。[admin.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/plugins/admin/admin.ts) 检查已有 banned 状态，不由密码失败自动设置。采用 API 自有 SQL 计数，见 §11。 |
| 撤销其他会话                     | **原生支持**                                                                  | [session.ts 的 revokeOtherSessions](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/api/routes/session.ts) 保留当前 token，删除该用户其他会话。[update-user.ts 的 changePassword](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/api/routes/update-user.ts) 设置 `revokeOtherSessions: true` 时删除会话并创建新的当前会话，必须转发新 cookie，不能假定当前 token 不变。change-password 返回 200 sessionResponseSchema，包含新会话的 expiresAt，前端直接替换缓存 session，不再 refetch。                                                   |
| 管理员重置其他用户密码           | **admin 插件支持**，核心不是自动的资料表授权                                  | [admin/routes.ts 的 setUserPassword](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/plugins/admin/routes.ts) 修改 credential 密码，但该方法本身不撤销目标用户会话，必须额外撤销。[has-permission.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/plugins/admin/has-permission.ts) 使用 `adminUserIds` 或 `session.user.role` 授权，不能直接以两张资料表动态判断。本项目不启用 admin 插件，采用普通 server function，见 §11。                                                                                                          |
| `auth` schema 与单独 pg 角色     | **原生数据库配置支持**，角色与 grants 由本项目迁移维护                        | [core init-options.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/core/src/types/init-options.ts) 定义 `schemaName`。[kysely-adapter dialect.ts](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/kysely-adapter/src/dialect.ts) 对对象形式数据库配置调用 `withSchema(schemaName)`。采用显式 Kysely + PostgresDialect + auth 专用 pg pool 配置 `{ db: authKysely, type: 'postgres', schemaName: 'auth', transaction: true }`。不能假定直接传裸 pg Pool 就有 schemaName，也不将该能力等同于 Drizzle adapter 的命名空间行为。                                            |
| 两张资料表映射，哪张存在决定身份 | **NOT supported**，无原生双资料表业务身份解析                                 | [core options](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/core/src/types/init-options.ts) 的用户 modelName 与 fields 只映射认证模型。[custom-session 插件](https://raw.githubusercontent.com/better-auth/better-auth/v1.7.7/packages/better-auth/src/plugins/custom-session/index.ts) 可用回调扩充响应，但资料 SQL 与互斥判断仍需项目实现，也不会自动改变 admin 插件授权。采用受限身份解析函数，见 §7。关联外键不是 Better Auth 插件自动实现。                                                                                                                                                  |

“NOT supported”只针对这里要求的完整行为，不能从文档里一个近似功能推断已经满足。账户锁定与身份解析采用项目自己的边界，不使用 admin 插件。能力核验表不能作为验收通过记录。

## 6. 数据库迁移、角色与邮箱收敛

新迁移 `0005_auth.sql` 由 owner 执行，SQL 和 `auth-schema.ts` 以最终安装版本的 schema 生成结果核对。至少包含 `auth.user`、`auth.session`、`auth.account`、`auth.verification`，以及项目自己的 `auth.login_failures`。Better Auth 字段名、ID 类型、时间和索引以实际生成结果为准，不在草图里臆造完整 DDL。认证表不启用 RLS，登录前无租户上下文。认证用户邮箱统一规范化并唯一，管理员与客户不能共用邮箱，这是阶段 2 已接受的代价。

`fs_billing_auth` 为 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`，无业务角色成员关系，不是表 owner。只授予 auth schema 的 USAGE 和选定认证表及 `auth.login_failures` 的 SELECT、INSERT、UPDATE、DELETE；若生成结构有 sequence，只给必需 sequence 权限。无 CREATE、TRUNCATE、迁移权限或业务表权限。撤销 PUBLIC 对 auth schema、表和相关函数的权限。检查默认权限，后续插件表必须显式追加 grants，不能不加审核地授权所有未来表。

API 环境新增 `AUTH_DATABASE_URL`、Better Auth secret、同域 base URL、可信 origin。配置验证用户名与实际连接 `current_user` 都是 `fs_billing_auth`。业务仍用 `APP_DATABASE_URL`；API 运行不需要 `DATABASE_URL`。迁移入口扩展设置认证角色密码，与现有 `migrateDatabase` 设置应用角色密码的方式一致；密码不能写进 SQL、日志或版本库。Worker 配置不被迫增加认证变量。

两张资料表各增加 `auth_user_id UNIQUE NOT NULL REFERENCES auth.user(id) ON DELETE RESTRICT`。保持现有 `admins.id`、`portal_accounts.id`，不改变账本和审计引用。再删除 `admins.email`、`portal_accounts.email` 及其原有唯一约束。通知设置中的收件邮箱不是账号邮箱副本，保留不变。

迁移已存在资料时，先核对规范化邮箱冲突。不同资料匹配同一个认证用户或历史跨表同邮箱时，迁移停止并报告冲突，不任选或合并。创建无可登录 credential 的 auth 用户，保留其原邮箱并回填关联；密码由明确的管理员初始化操作设置，不能在 SQL 内填默认明文密码。空库种子改为先创建 auth 用户再创建资料，使用稳定认证 ID 保证重复执行收敛，开发密码只由认证哈希接口生成。

`seed.ts` 当前用 `admins.email` 去重，`test/support.ts` 的 `adminId` 也直接按 email 找管理员，必须同批迁移这些调用者。邮箱查询改为 owner 种子阶段联结 auth.user 或按稳定资料 ID 找，运行时业务连接不因此获得 auth 表读取权限。SQL grants 不授予 `fs_billing_app` 读取 credential 或 session。

两表各自 UNIQUE 不能阻止同一 auth 用户同时出现在两表。解析器对 0 或 2 个匹配拒绝访问，测试覆盖。账户开通统一在一个可信边界检查映射，第一版没有公开 signup。不要声称两个 UNIQUE 已证明跨表唯一，也不为此新增 advisory 锁。若以后要求数据库在并发写入时也强制跨表排他，需要单独设计约束结构。

## 7. 请求身份、RLS 与事务

业务请求流为 cookie 验证、资料映射、access 判定、业务事务、明确输出投影。认证组件只持有 auth 连接，业务模块只持有业务连接。AuthGateway 从验证后的 session 返回受信任的 `user.id`、`user.email` 和 expiresAt。资料解析只提供业务身份，两者组合成浏览器 Identity，业务连接不额外联查 auth 表读取邮箱。

Fastify 包装器调用 Better Auth server API 时传递原请求的 cookie、Origin 及认证所需 header，保留 origin 与 CSRF 校验，成功并通过竞态与身份检查后转发全部 Set-Cookie，不能只取最后一个或用逗号合并。失败关闭时不转发 Better Auth 已产生的 cookie，并删除新 session。测试覆盖非可信 Origin 下的 cookie 写操作，以及改密码后替换 cookie 的实际可用性。

```text
浏览器 cookie
  → AuthGateway 验证 session 及 expiry，得到可信 authUserId、email、expiresAt
  → DB 受限身份函数读取 admins、portal_accounts、tenants
  → 全部关联恰好一个，再检查资料与租户状态 → Principal
  → access=admin 且 customer → 403 FORBIDDEN
  → customer → withTenant(businessDb, principal.tenantId, tx => handler(tx, principal))
  → admin → withAdmin(businessDb, tx => handler(tx, principal))
```

映射函数 `resolve_auth_identity(auth_user_id)` 采用 `SECURITY DEFINER LANGUAGE sql STABLE`。函数返回恰好一行，`kind` 为 `none`、`ambiguous`、`admin` 或 `customer`，以及必要的资料 ID、tenant ID、资料与租户状态和租户展示字段。参数类型与 `auth.user.id` 完全一致，参数只来自已验证 session。函数不返回邮箱或 authUserId。

owner 迁移创建专用角色 `fs_billing_identity NOLOGIN NOSUPERUSER BYPASSRLS`，再将函数所有权转交该角色。该角色仅取得必要业务 schema 的 USAGE，以及 `admins(id, auth_user_id, name, status)`、`portal_accounts(id, tenant_id, auth_user_id, status)` 和 `tenants(id, code, name, currency, status)` 的列级 SELECT。固定 `SET search_path = pg_catalog, pg_temp`，所有表使用 schema 限定名，无动态 SQL，无写操作。显式 `REVOKE EXECUTE FROM PUBLIC`，只授予 `fs_billing_app` EXECUTE。auth 角色既不能读资料，也不能调用函数。目录测试核对 owner、角色属性、列授权及函数权限，并断言 auth 角色调用报 42501。

函数先统计两表全部关联，不先过滤 disabled 资料。总匹配数为 1 才检查状态。一个 active admin 加一个 disabled customer 仍是双重关联，必须失败关闭，不能因过滤状态而获得管理员权限。身份测试必须覆盖这个混合状态场景。

除只验证 session 的 logout 外，租户停用与账号停用都在每次请求重新核对，不把可变状态当成长期 cookie 权限。禁用 Better Auth 的 `session.cookieCache`，`secondaryStorage` 必须 unset，撤销后下一次请求必须回源验证。启动时断言这两项配置，测试验证任一配置偏离即启动失败。session 更新与 profile 状态变化之间不能靠缓存中的 role 授权。

身份确定后才调用现有 `withTenant`。客户业务 SQL 同时显式带 `tenant_id = principal.tenantId`。资源详情带 tenant 和资源 ID 两个条件。余额示例从 `tenant_balances` 读取，不将任意 tenant 参数传到函数。RLS 使用同一事务、同一连接的 `set_config(..., true)`，提交或回滚后变量不能泄漏到池中下一次请求。管理员事务不复用客户 handler；客户绝不能走 `withAdmin` 或 `withSystem`。

`portalContext` 的租户只来自已验证 session 的业务资料映射。query 采用严格空对象，`tenantId`、`tenant_id` 等额外字段返回 400 `VALIDATION_ERROR`。身份 header 没有授权语义，伪造的 tenant、用户、资料和 role header 被忽略。Fastify 不解析 GET body，因此 GET body 中的伪造字段也被忽略，返回 200 时必须仍是 A 的身份、租户和余额。严格 body schema 约束可解析 body 的请求，不把 GET 的原始字节当作租户输入。IDOR 测试分别断言这些行为，不能只检查状态码。

RLS 防御的是漏写 SQL 条件，不防御持有应用数据库凭据的主体自行设置 `app.scope`。遵守阶段 2 的信任边界。客户只读限制、分区不能直接访问、账本只增和现有 `lock_tenants` 不变。没有新业务锁。已有最外层 `withAdmin` 的 `40P01`、`40001` 重试保留，嵌套和 handler 不再增加重试。认证库调用、cookie 写入、邮件与其他外部副作用不放进可重跑的业务事务回调。

## 8. OpenAPI 生成与 100% 越权枚举

使用与 Fastify 5、Zod 4 兼容的 Zod type provider 和 `@fastify/swagger`，实施时先核对并锁定版本。`apiContract` 是路由定义源，注册器安装 validator、serializer、各状态响应及 metadata。`app.ready()` 后从实际 Fastify 实例生成 OpenAPI，供导出脚本和测试使用，不能让测试只读取独立手写规格。

每个 operation 有稳定 `operationId`、`x-access` 和 `x-isolation-case`。OpenAPI 如需 audience 展示，从 access 推导，不作为共享契约的独立字段。`customer`、`session` 端点及 `authenticated` 中客户可用端点都进入客户可调用集合，包括 session、退出、改密码、撤销会话，不能只统计 `/portal`。public 登录和 health 不进入该集合，但要有认证和公共错误测试。所有实际 HTTP 路由必须有分类；生成文档不得隐藏受保护路由。契约、Fastify 实际业务路由和 OpenAPI 三个集合一致，缺 metadata、重复 ID、缺 case、额外 case 或非空集合被误生成为空时 CI 失败。HEAD 若框架自动生成，明确禁用自动派生或作为实际 operation 分类与测试，不能忽略。

测试为每个 OpenAPI operation 找一个可执行场景。case 是具体数据与预期行为，不是 allowlist。阶段 4 可分为 `tenant-read`、`self-session`、`self-credential`、`self-session-mutation`；后续新增详情、集合、导出、写操作时扩展类型与场景。一个模板自动生成请求，不代表已经覆盖端点所有行为。

使用真实 Better Auth 登录 cookie，为 A、B 两租户及管理员建立 fixture；至少两位同租户客户验证 profile 与 tenant 不是同一概念。每个场景先有正向证据再进行攻击。

API fixture 通过 `withAdmin` 和 `appendLedgerEntries` 写入两租户的充值流水，由数据库触发器更新缓存余额，不能直接改 `tenant_balances.balance`。固定余额标记仍为 A 的 `111.25` 和 B 的 `999.75`，共享测试库中的缓存余额必须始终等于流水合计。账本与审计日志只增，不能逐行删除 fixture 或关闭保护触发器。测试全局 setup 拥有一次运行的临时 `fs_billing_test` 数据库，运行前重建，运行结束 teardown 删除整个数据库，清理身份、会话、租户、流水和审计记录。ledger 差异测试继续对全库断言。

- tenant-read 正向返回 A 的固定余额和租户资料，再伪造 B 的 tenant query、body、header，结果拒绝或仍只返回 A。对未来详情端点用 B 的真实资源 ID 得到与缺失 ID 同形的 404；对集合和导出断言内容中没有 B 标记，并确认 B 自己能读到标记。
- self-session 断言返回 A 的实际身份及有效期限，不能只检查 200。伪造用户 ID 不得返回 B 身份。
- self-credential 和 self-session-mutation 为 B 建立可用会话，A 操作后 B 仍能登录或使用会话。A 的旧密码或其他会话按契约确实失效；不能只断言返回值。
- 管理员端点全部以客户会话请求，断言 403 `FORBIDDEN`，无管理数据或写入。未登录时断言 401 而非 403。

覆盖报告记录所有客户可调用 operationId、测试类别、运行结果和集合差异。覆盖率分母来自当次生成 OpenAPI，必须是 100%，新增未配 case 的客户端点立即使 CI 失败。不要用一个静态“共 N 个端点”数字作为验收。

### 8.1 去掉租户过滤的可重复证明

RLS 开启时，去掉 WHERE 仍然看不到 B，因此普通生产模式 IDOR 测试会通过。不能把它描述为已经检测到过滤遗漏。需要分别证明应用过滤与数据库防线，使用同一套 OpenAPI 枚举场景。

1. 基线以真实 `fs_billing_app` 和 RLS 运行 A、B 登录及 IDOR 测试，通过。
2. 在隔离测试进程中，使用仅测试支持模块注入的 owner 业务连接运行同一 handler 与场景，绕过 RLS，但仍从 session 派生 A，仍执行相同 `withTenant`。基线必须通过，证明显式过滤独立有效。生产配置拒绝 owner，不提供运行时开关、环境变量或公开参数切换此模式。
3. 对真实 `portalContext` 查询作一个可重复的源码变异，只删除 tenant WHERE，保留语法、认证和响应处理。余额单行查询明确使用 `ORDER BY tenant_id ASC LIMIT 1`，正常有过滤时返回 A；隔离 fixture 令 B 的 tenant UUID 严格小于 A 及其余资料，删除过滤后确定返回 B 的特征余额，不依赖插入顺序或无序查询。隔离临时 checkout 构建变异代码，同一 IDOR suite 的应用过滤 lane 必须失败，错误必须是读取到 B 标记或错误租户余额，不能以编译失败、登录失败或测试超时代替。再核对底层变异查询实际返回 B，而非只证明结果集合可能包含 B。
4. 同一个变异回到 app 角色与 RLS 开启 lane，A 请求仍只见 A，B 正向仍可见 B。再以 A 事务直接运行去过滤的 SQL，断言返回集合只有 A。这是 RLS 阻挡证明，不是 RLS 报错检测缺 WHERE。
5. 双防线测试分别命名与输出。mutation 脚本仅在测试 checkout 改代码，结束清理，不修改工作分支、不关闭生产 RLS。CI 只有在“应用过滤预期断言失败”和“RLS 防泄露通过”同时成立才通过证明步骤。

后续真正的详情端点加入后，继续对 B 的真实资源 ID 做同样变异。测试 DB owner 连接只能在测试支持中构造，生产入口不接收可选择绕过角色的配置。该证明不增加新锁或业务重试。

## 9. 验收与证据映射

以下是后续 API 与 DB 的实施计划。本次只验证共享契约，不将后端功能测试记录为通过。

| 阶段 4 后端验收                                      | 测试与证据                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 客户登录进入门户、管理员进入后台                     | `auth.db.test.ts` 真实登录，断言身份联合、expiresAt、cookie 属性和 session 实际行。前端依此 kind 路由，页面跳转由前端 E2E 验证。                                                                                                                                                                                                                                                                                                            |
| 客户访问后台接口为 403                               | 从 OpenAPI 枚举 admin operation，A、B 客户各请求，断言 `FORBIDDEN`、无管理响应及写入；管理员正向请求断言具体身份。                                                                                                                                                                                                                                                                                                                          |
| auth 非 RLS schema、专用角色最小授权                 | DB catalog 核对 schema、RLS flags、owner、role 属性、membership、grants、序列与函数。auth 角色读业务表/调用身份函数报 42501，app 角色读 auth.account/session 报 42501，auth 角色实际能完成登录与会话写入。                                                                                                                                                                                                                                  |
| auth_user_id UNIQUE NOT NULL 1:1、删除 profile email | 空库迁移及迁移重跑，SQL 与 Drizzle 列核对；重复关联、空关联和悬空 FK 均失败；资料表无 email。旧库保留资料与账本 ID，跨表同邮箱迁移失败且不留下半完成结构。                                                                                                                                                                                                                                                                                  |
| 停用后的 session 与退出                              | 已登录后停用账号或租户，session 与 portal/context 返回 403 ACCOUNT_DISABLED；logout 204 并清除 cookie、删除当前 session，随后 401。资料缺失或双重匹配时 logout 也有效。                                                                                                                                                                                                                                                                     |
| bodyless POST                                        | 真 HTTP 测试覆盖无 body 且无 Content-Type、JSON `{}` 均通过，额外字段拒绝；204 没有响应体。                                                                                                                                                                                                                                                                                                                                                 |
| Fastify 按 IP 限流                                   | §11.1 的同 IP 跨邮箱及两路由共享限流、换 IP、窗口恢复、Retry-After、代理伪造、counter 和 logout 行为。                                                                                                                                                                                                                                                                                                                                      |
| 两类身份映射                                         | 0、1、2 个资料匹配，停用资料、停用租户；任何不合法匹配失败关闭。伪造 auth role、metadata、tenant header 不产生管理身份。                                                                                                                                                                                                                                                                                                                    |
| 租户只从 session 获得，RLS 兜底                      | 真 cookie A/B、两同租户账号，池复用及事务回滚测试。未设置 scope 查询无业务行，tenant 写入失败，跨租户读与分区直接读被拒。                                                                                                                                                                                                                                                                                                                   |
| 连续失败账户锁定                                     | 可控时间验证先原子计数再验密码、第 5 次失败、15 分钟连续窗口及固定锁期、成功清零、依赖失败退款、锁中不计数不续期、换 IP 不绕过、并发不超过 5 次验证。未知邮箱同计数及同响应，安装源码核对 dummy hash；改密码共享计数，重置解锁，owner CLI、清理和结构化锁日志均有证据。                                                                                                                                                                     |
| 撤销其他会话与改密码                                 | 为 A 建三个设备会话，为 B 建一个。撤销 A 其他会话后当前 A 仍可用、其他 A 401、B 可用。改密码验证旧密码拒绝、新密码成功、新 cookie 可用、其他会话 401，以及 200 响应 expiresAt 等于新 session 行。                                                                                                                                                                                                                                           |
| 管理员重置密码                                       | 普通客户不能调用；管理员按真实资料身份调用；新密码有效、旧密码无效、目标全部旧 session 401、其他用户会话可用。两条资料表路径均覆盖；管理员自重置返回 403 FORBIDDEN，密码、counter 和所有 session 不变，change-password 正常返回新 session；credential 更新非 1 行则回滚，撤销失败则密码更新一同回滚，提交后审计失败只告警。注入并发登录与改密码，证明 credential 版本检查与行锁拒绝重置前凭据产生的新 session。敏感值不进入日志与审计详情。 |
| OpenAPI 客户端点 100% IDOR，CI 执行                  | 自动导出实际 app OpenAPI，三集合一致、case 完整、所有 operation 的正向与 A→B 攻击通过，输出 operation 覆盖报告。                                                                                                                                                                                                                                                                                                                            |
| 去掉一个端点过滤仍能被测试与 RLS 阻挡                | §8.1 的源码变异，应用过滤 lane 按泄露断言变红，生产 RLS lane 保持隔离；记录断言差异和查询证据。                                                                                                                                                                                                                                                                                                                                             |
| 登录过期跳转并回原页面                               | 后端对已过期、撤销、cookie 缺失分别验证统一错误契约、无数据响应；前端 E2E 从具体路径触发 401，重登后回合法原路径，403 不重登。                                                                                                                                                                                                                                                                                                              |

金额显示、费率显示、主题、375px 登录页和 404 截图属于阶段 4 前端验收。后端只保证金额字符串、币种、错误代码及响应 schema，不用后端测试代替截图或浏览器行为证明。

## 10. CI 调整与实施顺序

沿用 `.github/workflows/ci.yml` 的 frozen lockfile、`pnpm check`、coverage、build、PostgreSQL 启动、空库迁移和 `pnpm test:db`。数据库全局 setup 已创建独立测试库，扩展 auth 角色与认证 fixture，注入 auth URL，不修改 Worker 的环境契约。

1. 先交共享 schema、contract 及无数据库依赖的契约测试，前端可开始开发。
2. 取得并精确锁定认证发布包、匹配的 Kysely、`@fastify/rate-limit@10.3.0` 与 Fastify OpenAPI 工具版本，核对安装源码与生成结构。按 §11 最终决定追加迁移和种子适配，先运行权限与资料测试。
3. 接 auth gateway、身份解析和真实上下文读端点。运行真实 cookie 认证、角色边界及 RLS 测试。
4. 新增 OpenAPI 导出检查、客户操作覆盖报告和独立 IDOR 步骤，DB 启动后运行。新增遗漏 case 的契约负例，证明覆盖检查确实失败。
5. 新增源码过滤变异步骤，独立隔离临时 checkout 和测试数据库。只有预期的泄露断言失败可视为变异被杀死；常规测试失败仍是 CI 失败。上传 OpenAPI JSON、operation 报告、变异差异与 RLS 证据，不上传 cookie、密码或连接串。

最外层重试保持现有 DB 规则，不再包一层 API 重试，也不对认证失败或未知外部副作用自动重跑。没有新增 advisory 锁、进程锁或 tenant 锁类型。账户锁定只使用原子条件 DML 和数据库既有约束，不新增显式锁协议。

实施中若安装包 API 或表结构与标签证据不符，先记录差异并解决兼容性，再实现。技术核验不能重新打开已批准的产品决定。本次未实现 DB 或 API，也没有把对应测试记作通过。

## 11. 最终认证决定

用户已采纳全部简化方案，OIDC 排除。以下决定是实施要求，不再作为待选项。

### 11.1 API 自有 SQL 账户锁定

`POST /api/auth/login` 是唯一登录入口，不挂载 Better Auth catch-all 登录路由。API 使用 `auth.login_failures(email_key text PRIMARY KEY, failed_count integer, last_failed_at, locked_until)` 维护计数。`email_key` 与安装版本 Better Auth 查询用户时的邮箱规范化完全相同，未知邮箱也创建行。实现前读取实际安装源码，核对 normalization 与未知邮箱的 dummy password hash 路径。

在密码验证前，以单条原子 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 预占一次尝试。若上次失败超过 15 分钟，先重置计数。第 5 次尝试预占后可验证密码，同时设置固定 15 分钟锁期，后续尝试立即拒绝。密码正确则清零并解锁。密码错误保留计数，DB 或认证基础设施失败退还该次预占，不得把依赖失败算成密码错误。退款需保护并发计数，不能覆盖别的请求的计数或锁期。

实施细节：`auth.login_failures` 增加 `window_id uuid NOT NULL`。新行和 15 分钟窗口过期重置均生成新 UUID，同一窗口内的预占保留 UUID。预占返回 UUID，退款只在邮箱与预占的 `window_id` 同时匹配时原子递减。成功、重置或紧急解锁删除旧行后，重建行必有新 UUID，因此旧请求不能递减新窗口或解除新锁。同一窗口内即使有后续预占，基础设施失败仍退还一次计数。该字段落实已经批准的基础设施失败退款规则，不是新的产品决定。

`locked_until > now()` 时拒绝，包括正确密码。锁期间的请求不验密码、不计数、不延长锁期。第 5 次错误密码请求及锁中请求返回 429 `ACCOUNT_LOCKED`，附带 `retryAfterSeconds` 与 `Retry-After`。普通未知邮箱与错误密码返回完全相同的 401 `INVALID_CREDENTIALS`、消息和时间行为。若安装版本不执行 dummy hash，API 补齐同等验证工作。未知邮箱也能得到同样的锁定响应。

改密码对当前密码的猜测使用同一 email counter，按相同的先计数、成功清零、依赖失败退款规则处理。Fastify 在调用 Better Auth server API 前执行按 IP 限流，不依赖 Better Auth HTTP router 的内置限流。采用精确版本 `@fastify/rate-limit@10.3.0`，已安装并固定锁文件与 integrity。该版本的 [package.json](https://raw.githubusercontent.com/fastify/fastify-rate-limit/v10.3.0/package.json) 与 [兼容表及配置说明](https://raw.githubusercontent.com/fastify/fastify-rate-limit/v10.3.0/README.md) 已核对，10.x 支持 Fastify 5；已核对实际安装包。注册插件后才注册路由，使用 onRequest hook、request.ip 和登录与改密码共享的 credential group，初始为每 IP 每分钟 30 次。全局关闭，只对这两条凭据路由启用，logout 不受该组限流影响。trustProxy 默认关闭，部署代理时只信任已配置的代理地址，不接受任意 X-Forwarded-For。第一版单 API 进程采用内存 store，多进程或多实例部署前必须提供共享 store。

自定义 errorResponseBuilder 或统一错误适配器返回契约 429 RATE_LIMITED，包含 requestId、中文 message、正整数 retryAfterSeconds 和同值 Retry-After。剩余毫秒向上取整为秒且至少 1 秒，ban 保持关闭，不能产生插件默认 403 或默认错误 JSON。限流在账户失败预占和密码验证之前，超限不改 email counter。不同 IP 不能绕过 email 锁定。真实 HTTP 测试以同 IP 不同邮箱及登录、改密码交替请求证明共享限流，另一 IP 正常；检查 429 body、Retry-After、窗口恢复、伪造转发 header 无效、counter 未增加，以及限流时 logout 仍可用。

`@fastify/rate-limit@10.3.0` 的每路由配置会建立独立的 LocalStore；相同 `groupId` 只修改 key，不能合并这些 store。注册器只创建一次 `app.rateLimit(...)` hook，把同一 hook 安装到 login 和 changePassword 的 `onRequest`。各路由的自动限流配置关闭，避免重复计数。共享 store 使用插件默认的 `request.ip` key，`trustProxy: false` 保证伪造 `X-Forwarded-For` 不改变 key。

管理员重置密码同时清除目标锁定。另提供使用 owner 凭据运行的紧急解锁 CLI，恢复所有管理员被锁的情况。每次进入锁定记录结构化日志，不在日志记录密码或 cookie。过期且无活动窗口的 counter 行定期或机会式清理，避免未知邮箱行无限增长。

### 11.2 专用角色拥有受限身份函数

采用 §7 的 `SECURITY DEFINER LANGUAGE sql STABLE` 函数，由专用 `NOLOGIN NOSUPERUSER BYPASSRLS` 角色拥有。角色只有必要列的 SELECT，函数固定 `search_path = pg_catalog, pg_temp`，表名全限定，PUBLIC 无 EXECUTE，只有 app 角色可执行。

函数先统计两张资料表的全部匹配，再检查状态。0 个返回 `none`，2 个返回 `ambiguous`，均拒绝访问。恰好 1 个返回 `admin` 或 `customer`。一个启用管理员加一个停用客户仍然是歧义，不得先过滤状态。`authUserId` 仅存在 API 内部 `Principal`，绝不输出到浏览器 Identity。

登录必须先验证密码，才能响应 `ACCOUNT_DISABLED` 或 `IDENTITY_UNAVAILABLE`。Better Auth 已创建 session 时，API 删除该 session，不发送任何 Set-Cookie。测试必须检查无残留 session，不能只检查状态码。

### 11.3 普通 server function 执行管理员重置

不启用 admin 插件，不维护 `auth.user.role` 镜像，不创建插件 HTTP 重置端点。API 普通 server function 接收已验证管理员 `Principal`，用管理员业务范围解析目标资料的 `auth_user_id`。两条独立路由分别为 `/api/admin/portal-accounts/{id}/reset-password` 与 `/api/admin/admins/{id}/reset-password`，请求不带目标 role 或 authUserId。管理员重置路由的目标 profileId 等于当前管理员 profileId 时，返回 403 FORBIDDEN。检查先于临时密码生成、credential 更新、计数清除和会话撤销，当前 cookie 与全部 session 保持有效。管理员修改自己的密码使用 change-password。

临时密码由 `crypto.randomBytes` 生成，哈希只能使用 `(await auth.$context).password.hash`。Better Auth 固定精确版本 `1.7.7`。安装源码、哈希接口、credential 字段及重置后 `signInEmail` 登录均需兼容性测试。临时密码只在一次成功响应中返回，响应 `Cache-Control: no-store`，不进入日志或审计详情。

### 11.4 重置和撤销使用认证连接的一次 SQL 事务

认证连接开启一个事务，执行 `UPDATE auth.account SET password = $hash, updated_at = now() WHERE user_id = $target AND provider_id = 'credential'`。更新必须恰好影响 1 行，否则事务失败。随后 `DELETE FROM auth.session WHERE user_id = $target`，并清除该规范化邮箱的锁定计数，一并提交。删除 session 失败时密码更新回滚。

提交之后在业务连接写入 `operation_logs`，不含密码。审计失败产生告警或结构化错误日志，不回滚已完成的重置，不把审计失败伪装成密码未修改。无跨连接原子审计承诺。

### 11.5 登录和改密码防止并发重置留下会话

调用 `signInEmail` 前读取 credential 的 `account.updated_at::text` 版本，保留 PostgreSQL 时间精度。成功后在事务内用 `SELECT ... FOR SHARE` 重读同一用户的 credential；行锁等待已经 UPDATE 但尚未 COMMIT 的重置。版本有任何变化、credential 缺失或不是恰好一行，都删除本次 session，返回 401 `INVALID_CREDENTIALS`，不发送 Set-Cookie。不能使用 `updated_at > 登录开始时间`，因为 UPDATE 时间早于 COMMIT，也不能依赖应用与数据库时钟同步。确定性交错测试在重置 UPDATE 后暂停，再开始旧密码登录；确认登录已创建 session 且 FOR SHARE 被阻塞后才释放重置，断言拒绝、无 cookie、无残留 session。

改密码保留现有保护。改密码自身会更新 `updated_at`，不能把自身更新误判成并发重置。UPDATE 在行锁保护的写入边界核对验证所用 credential 版本，并保留 `updated_at <= t0` 条件。确定性交错测试同时证明正常改密码成功，以及并发重置不能被旧密码改回或留下有效 session。

必须禁用 `session.cookieCache`，`secondaryStorage` 必须 unset；启动时断言 `(await auth.$context).options` 的有效配置，不能只检查传入的字面量，并测试启用时拒绝启动。否则删除数据库 session 无法可靠撤销权限。

### 11.6 本次范围与后续核验

步骤 1、2 的设计和共享契约已完成；步骤 3 已实现 DB、API、锁定、撤销、重置与测试。Better Auth 1.7.7 和 @fastify/rate-limit 10.3.0 已安装并精确锁定，实际源码核对见 §12.1。共享包仍不导入 DB、API server 或 Better Auth。包含评审修复的 Bot 验证记录见 §12.3，没有新的产品决定。

## 12. 步骤 3 实施记录与 Bot 验证

分支为 `phase-4-api`。检查点中的退款问题已按用户指定的 option 1 解决，作为 §11.1 实施细节记录。后端功能、测试、CLI、OpenAPI 和 CI 配置已实现。Bot 已完成下列验证。

### 12.1 实际安装源码核验

核验对象为 `apps/api/node_modules` 的锁定发布包，不使用在线标签代替安装源码。

| 对象                                 | 实际源码                                                                            | 结果                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth 1.7.7 登录规范化         | `better-auth/dist/api/routes/sign-in.mjs:318`                                       | `email.toLowerCase()`，不 trim。API counter 使用同样规范化。                                                                                                                                                                    |
| 未知邮箱、缺 credential、空 password | 同文件 `321`、`328`                                                                 | 执行 `ctx.context.password.hash(password)` 后返回同一个 `INVALID_EMAIL_OR_PASSWORD`。已存在凭据使用 `password.verify`。credential 匹配同时要求 `providerId='credential'` 与 `accountId=user.id`。                               |
| 密码哈希接口                         | `better-auth/dist/context/create-context.mjs:182`                                   | `$context.password.hash` 与 `.verify` 为配置或默认实现。重置及测试 fixture 通过此接口生成哈希。                                                                                                                                 |
| PostgreSQL schema                    | `@better-auth/kysely-adapter/dist/index.mjs:26-59`                                  | `schemaName` 只支持 postgres，要求非空，实际应用 `db.withSchema(schemaName)`；配置使用 `auth`。                                                                                                                                 |
| 核心表结构                           | `@better-auth/core/dist/db/get-tables.mjs`、`better-auth/dist/db/get-migration.mjs` | 四张核心表，ID 为 text，PostgreSQL 日期为 timestamptz。user.email、session.token 唯一；session/account 的 user_id、verification.identifier 索引。session/account.updated_at 没有 SQL default。使用 fields 配置映射 snake_case。 |
| session 缓存                         | `better-auth/dist/api/routes/session.mjs`                                           | cookieCache 启用时可能绕过 DB。工厂显式设 `enabled:false`，启动断言同时拒绝 secondaryStorage。`app.test.ts` 已验证启用 cookieCache 或配置 secondaryStorage 时启动断言失败。                                                     |
| 密码长度                             | `better-auth/dist/utils/password.mjs`                                               | 安装版本在验证前拒绝超过配置 128 字符的登录密码。共享登录 schema 保留 min(1)，gateway 把该拒绝转换为统一凭据错误并计数，不作为基础设施故障。                                                                                    |

没有新增依赖。pnpm 安装产生的 Drizzle peer 实例不同，API 与 DB 直接分别导入 SQL 运算符会产生 nominal type 不兼容。由 `@fs-billing/db` 导出其 `sql`、`eq`、`asc`，API 使用同一实例，不更改安装版本。

旧资料迁移保留 UUID，创建规范化邮箱的 auth.user，不自动创建旧账号 credential。跨资料规范化邮箱重复时在任何结构变更前失败。种子支持可选已通过 Better Auth 哈希的 credential；`auth:seed` 通过 `$context.password.hash` 初始化开发种子 credential，必须提供 `SEED_AUTH_PASSWORD`，拒绝 production，重复运行不覆盖已有 credential。FreeSWITCH 测试种子已改为关联 auth.user，未改变 Worker 业务。

登录和退出的 403 响应契约补充 `FORBIDDEN`，供不可信 Origin 的写请求使用。这与既定 CSRF 要求一致，不改变身份规则。

### 12.2 退款窗口实施与确定性交错证据

`window_id` 是 §11.1 的实现细节，用户已指定采用 UUID 代次。单条预占 SQL 在插入或过期重置时生成新 UUID，退款只更新同一 UUID 的行，不新增锁或重试。

`apps/api/src/auth.db.test.ts` 为登录和改密码分别覆盖旧请求等待期间删除重建 counter、过期重置窗口、同窗口后续预占，以及第五次预占退款解锁。删除重建案例保持新窗口的五次计数与固定锁期，旧退款不能修改它。测试通过可控 hooks 建立交错，不用定时 sleep 猜竞态。

### 12.3 验证与交付

本地 typecheck、lint、format 和 unit 检查记录见 [API 运行与证据](phase-4-api.md)。OpenAPI 从真实 app 导出 10 个操作，工厂在顶层注册 Swagger，避免子作用域让导出端无法读取文档。源码和安装核心 schema 的比较、五张 auth 表的逐项 CRUD 权限、资料迁移保持账本引用均有 DB 测试。

`idor.db.test.ts` 从同次 live OpenAPI 提取 customer、authenticated、session 操作，逐个运行正向结果与 A 到 B 攻击，额外或缺失 case 均失败。`prove:idor` 在临时 checkout 删除门户余额 WHERE，依次验证基线 app、基线 owner、变异 owner 的特定 B 余额断言失败和变异 app 的 RLS 防线通过。报告只含 OpenAPI、operation 分类、断言结果和源码差异，不上传环境、密码、cookie 或会话 token。

CI 在数据库 setup 后执行 DB suite 与变异证明，并上传隔离证据。API 脚本使用 `node --import tsx`，避免 tsx CLI 的 IPC socket 对 sandbox 的额外要求。生产只接受业务 app 角色与 auth 角色连接，owner lane 只存在于测试支持。

Bot 已完成 `pnpm check`（309 pass）、`pnpm test:db` 连续三次（每次 235 pass）、`pnpm test:idor`（15 pass）、`prove:idor`、OpenAPI 导出和 build。依赖已安装并锁定。这是 Bot 验证记录；PR #18 的 CI 与 FreeSWITCH integration 均通过，所有 SIPp e2e 用例均为 PASS，见 [CI 与联调证据](evidence/phase-4-api/ci.txt)。没有新的用户产品决定，前端验收状态不变。

### 12.4 评审修复的运维边界

生产 owner 使用 `auth:bootstrap` 为已存在的 admin 或 portal profile 创建首个 credential，详见 [运行说明](phase-4-api.md)。不通过 API 暴露 bootstrap；替换凭据须显式 `--replace`，并在同一事务撤销会话。

运行时邮箱规范化统一使用 Better Auth 相同的 JavaScript `email.toLowerCase()`，不 trim。迁移冲突检查仍使用 SQL `lower()`；其非 ASCII 行为取决于数据库 collation，迁移前须按 JS 规则另查重复邮箱，不能把 SQL 结果视为与运行时完全等价。

Gateway 复制了 Better Auth session cookie 的 HMAC 签名、编码、cookie 名与属性，并为改密码设置七天 session，没有滑动续期。升级 Better Auth 时必须复核这些内部约定、会话有效期与 cookie 行为；版本锁定和兼容测试不能消除重复实现的风险。

未知路由返回契约 404 NOT_FOUND。框架请求错误（包括 body 过大 413、媒体类型不支持 415、JSON 无效 400）统一为契约 400 VALIDATION_ERROR，不新增共享错误码。退出遇到已过期会话仍返回 401 SESSION_EXPIRED，同时删除 session 并清除 cookie；不可信 Origin 仍先返回 403 FORBIDDEN。锁定事件中的 emailKey 使用以服务 secret 为 key 的 HMAC-SHA256，不记录原邮箱。
