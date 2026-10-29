import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { databaseEnvironmentSchema } from '@fs-billing/db';

function privateIpv4(value: string) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31)
  );
}
/** `.env` 里写成空的键（`SMTP_HOST=`）等同于没设置。 */
const blankToUndefined = (value: unknown) => (value === '' ? undefined : value);
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess(blankToUndefined, schema.optional());

const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const IMPLICIT_TLS_PORT = 465;
// 这些端口约定俗成是 STARTTLS 或明文提交端口，配隐式 TLS 会握手超时。
const STARTTLS_PORTS = [25, 587, 2525];

/** 回环地址：Mailpit 之类的本机测试服务，只有它们允许不加密、不认证。 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    bare === 'localhost' ||
    bare === '::1' ||
    (isIP(bare) === 4 && bare.split('.')[0] === '127')
  );
}
const isQqHost = (host: string) => {
  const lower = host.toLowerCase();
  return lower === 'qq.com' || lower.endsWith('.qq.com');
};

// 配置错误信息不回显取值（SMTP_PASS 在 QQ 邮箱是授权码）：所有校验信息都是固定文字。
export const mailEnvironmentShape = {
  // 不设置则邮件发送未启用：Worker 启动时记 warn，发件箱照常入队。
  SMTP_HOST: optional(
    z
      .string()
      .trim()
      .refine(
        (value) =>
          isIP(value.replace(/^\[|\]$/g, '')) !== 0 || HOSTNAME.test(value),
        'SMTP_HOST 必须是主机名或 IP 地址',
      ),
  ),
  SMTP_PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(65535).default(IMPLICIT_TLS_PORT),
  ),
  // true = 隐式 TLS（465）；false = 必须 STARTTLS（回环地址除外）。
  SMTP_SECURE: z.preprocess(
    blankToUndefined,
    z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
  ),
  SMTP_USER: optional(z.string().min(1).max(320)),
  // QQ 邮箱里是授权码，不是登录密码。
  SMTP_PASS: optional(z.string().min(1).max(500)),
  MAIL_FROM: optional(z.email()),
  // 连接、问候、套接字三个超时共用。
  SMTP_TIMEOUT_MS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1000).max(120000).default(15000),
  ),
  // 每次分发最多发送的封数（tick 每分钟一次）。
  MAIL_RATE_PER_MINUTE: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(1000).default(20),
  ),
  MAIL_MAX_ATTEMPTS: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(20).default(6),
  ),
  // 事件型告警的静默恢复窗口（分钟），决定 35。
  ALERT_QUIET_MINUTES: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(1440).default(10),
  ),
  // 邮件里链接的站点根地址；没有则邮件不含链接。
  APP_PUBLIC_URL: optional(
    z
      .string()
      .trim()
      .transform((value, context) => {
        const url = URL.canParse(value) ? new URL(value) : undefined;
        const valid =
          url !== undefined &&
          (url.protocol === 'https:' ||
            (url.protocol === 'http:' && isLoopbackHost(url.hostname))) &&
          url.username === '' &&
          url.password === '' &&
          url.pathname === '/' &&
          url.search === '' &&
          url.hash === '';
        if (!valid) {
          context.addIssue({
            code: 'custom',
            message:
              'APP_PUBLIC_URL 必须是站点根地址：https://…（本机调试可用 http://127.0.0.1:端口），不含路径、账号、查询串',
          });
          return z.NEVER;
        }
        return url.origin;
      }),
  ),
};

const mailEnvironmentObject = z.object(mailEnvironmentShape);
type MailEnvironmentInput = z.infer<typeof mailEnvironmentObject>;

/** 跨键校验：拒绝自相矛盾的组合。信息固定，不回显取值。 */
export function refineMailEnvironment(
  env: MailEnvironmentInput,
  context: z.RefinementCtx,
): void {
  const fail = (key: keyof MailEnvironmentInput, message: string) =>
    context.addIssue({ code: 'custom', path: [key], message });
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = env;
  if (host === undefined) {
    // 只写了账号没写主机多半是 SMTP_HOST 拼错了：直接报错，不要悄悄关掉邮件又留着授权码。
    if (user !== undefined)
      fail('SMTP_USER', '设置了 SMTP_USER 却没有 SMTP_HOST');
    if (pass !== undefined)
      fail('SMTP_PASS', '设置了 SMTP_PASS 却没有 SMTP_HOST');
    return;
  }
  if (env.MAIL_FROM === undefined)
    fail('MAIL_FROM', '设置了 SMTP_HOST 就必须设置 MAIL_FROM');
  if ((user === undefined) !== (pass === undefined))
    fail('SMTP_PASS', 'SMTP_USER 与 SMTP_PASS 必须同时设置或同时不设置');
  const loopback = isLoopbackHost(host);
  if (!loopback && (user === undefined || pass === undefined))
    fail(
      'SMTP_USER',
      '非回环地址的 SMTP 服务器必须认证：需要 SMTP_USER 与 SMTP_PASS',
    );
  if (env.SMTP_SECURE && STARTTLS_PORTS.includes(env.SMTP_PORT))
    fail(
      'SMTP_SECURE',
      `端口 ${env.SMTP_PORT} 是 STARTTLS 端口，SMTP_SECURE 应为 false；隐式 TLS 用 465`,
    );
  if (!env.SMTP_SECURE && env.SMTP_PORT === IMPLICIT_TLS_PORT)
    fail('SMTP_SECURE', '端口 465 是隐式 TLS 端口，SMTP_SECURE 不能为 false');
  // QQ 邮箱只接受发件人等于认证账号的邮件；上线才发现被拒或被改写代价太高，启动时就拦住。
  if (
    isQqHost(host) &&
    env.MAIL_FROM !== undefined &&
    env.MAIL_FROM.toLowerCase() !== user?.toLowerCase()
  )
    fail('MAIL_FROM', 'QQ 邮箱的 MAIL_FROM 必须与 SMTP_USER 相同');
}

/** 邮件模块用的配置：mail:test 与 Worker 共用，不含 WORKER_* 等无关键。 */
export const mailEnvironmentSchema = mailEnvironmentObject.superRefine(
  refineMailEnvironment,
);

export interface MailSettings {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string | undefined;
  /** 秘密：只用于建立 SMTP 连接，不进日志、不进错误信息。 */
  readonly pass: string | undefined;
  readonly from: string;
  readonly timeoutMs: number;
  readonly ratePerTick: number;
  readonly maxAttempts: number;
  readonly siteUrl: string | undefined;
}

/** SMTP_HOST 未设置返回 undefined（邮件发送未启用）。 */
export function mailSettingsOf(
  env: z.infer<typeof mailEnvironmentSchema>,
): MailSettings | undefined {
  if (env.SMTP_HOST === undefined || env.MAIL_FROM === undefined)
    return undefined;
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
    from: env.MAIL_FROM,
    timeoutMs: env.SMTP_TIMEOUT_MS,
    ratePerTick: env.MAIL_RATE_PER_MINUTE,
    maxAttempts: env.MAIL_MAX_ATTEMPTS,
    siteUrl: env.APP_PUBLIC_URL,
  };
}

export const workerEnvironmentSchema = z
  .object({
    ...mailEnvironmentShape,
    APP_DATABASE_URL: databaseEnvironmentSchema.shape.APP_DATABASE_URL,
    WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    WORKER_QUEUE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(2),
    WORKER_DB_CONNECTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60000)
      .default(5000),
    WORKER_RECONCILE_MIN_AGE_MINUTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(10080)
      .default(5),
    WORKER_RECONCILE_ALERT_ATTEMPTS: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(3),
    WORKER_RECONCILE_LOOKBACK_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(365)
      .default(30),
    WORKER_STATEMENT_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),
    // 原始 JSON 归档（阶段 8）：本地目录，必须是绝对路径；不设置则不启用归档（启动时告警）。
    RAW_CDR_ARCHIVE_DIR: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z
        .string()
        .refine((value) => isAbsolute(value), '归档目录必须是绝对路径')
        .optional(),
    ),
    // 月份 M 的原文在 M 月末之后再过这么多个月才归档。
    RAW_CDR_ARCHIVE_AFTER_MONTHS: z.coerce
      .number()
      .int()
      .min(1)
      .max(120)
      .default(6),
    // 分离之后保留 raw_cdrs_YYYY_MM_archived 这么多天再丢弃。
    RAW_CDR_ARCHIVE_GRACE_DAYS: z.coerce
      .number()
      .int()
      .min(0)
      .max(365)
      .default(7),
    WORKER_HOST: z
      .string()
      .refine(privateIpv4, '只能监听内网或回环 IPv4 地址')
      .default('127.0.0.1'),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    WORKER_SHARED_KEY: z.string().min(16),
    WORKER_ALLOWED_IPS: z
      .string()
      .transform((value) => value.split(',').map((ip) => ip.trim()))
      .pipe(
        z
          .array(
            z
              .string()
              .refine((value) => isIP(value) !== 0, 'IP 白名单格式错误'),
          )
          .min(1),
      ),
  })
  .superRefine(refineMailEnvironment);
