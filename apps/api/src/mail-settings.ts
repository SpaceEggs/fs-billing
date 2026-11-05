import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  decryptSetting,
  readEffectiveMailRecord,
  readMailDeliveryStatus,
  recordMailSettingsTest,
  requiresNewPassword,
  SettingsDecryptError,
  SMTP_PASSWORD_AAD,
  updateMailSettings,
  AdminServiceError,
  type Db,
  type MailTestResult,
} from '@fs-billing/db';
import {
  classifySmtpError,
  createMailTransport,
  MAIL_FROM_NAME,
  mailEnvironmentSchema,
  testMessageId,
  type MailSettings,
  type MailTransport,
} from '@fs-billing/mailer';
import {
  renderMail,
  type AdminMailDelivery,
  type AdminMailSettingsEnvironment,
  type AdminMailSettingsResponse,
  type AdminMailSettingsTestRequest,
  type AdminMailSettingsUpdateRequest,
  type AdminMailSettingsTestResponse,
  type AuditActor,
  type MailSettingsSource,
  type ValidationIssue,
} from '@fs-billing/shared';
import { ApiFailure } from './errors.js';

/**
 * 生产环境拒绝连接这些地址，开发环境保留（Mailpit 要用）。
 * 含 100.64.0.0/10：云厂商内部服务在这个范围，比如阿里云元数据服务 100.100.100.200。
 */
const PRIVATE_IPV4 = [
  /^0\./,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.1[89]\./,
  /^(22[4-9]|2[3-5]\d)\./,
];
/** `::`、`::1`、IPv4 映射 `::ffff:*`、`fc00::/7`、`fe80::/10`。 */
const PRIVATE_IPV6 = /^(?:::1?$|::ffff:|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/;
const ALLOWED_PORTS = new Set([25, 465, 587, 2525]);

export type MailHostLookup = (
  host: string,
) => Promise<readonly { address: string }[]>;

export interface MailSettingsRuntime {
  /** `SETTINGS_ENCRYPTION_KEY`；未配置为 undefined。 */
  readonly key?: Buffer | undefined;
  /** 非生产环境为 true：允许任意端口与回环/私网地址。 */
  readonly allowPlaintext: boolean;
  readonly timeoutMs: number;
  /** 环境变量来源的非秘密值。 */
  readonly env: AdminMailSettingsEnvironment;
  /** 测试注入；默认用 nodemailer（`pool: false`）。 */
  readonly transportFactory?:
    ((settings: MailSettings) => MailTransport) | undefined;
  /** 测试注入；默认 `dns.lookup(host, { all: true })`。 */
  readonly lookupHost?: MailHostLookup | undefined;
}

const defaultTransportFactory = (settings: MailSettings): MailTransport =>
  createMailTransport(settings, { pool: false });

async function defaultLookupHost(
  host: string,
): Promise<readonly { address: string }[]> {
  const results = await lookup(host, { all: true });
  return results.map((result) => ({ address: result.address }));
}

const normalizeHost = (host: string): string =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

function isPrivateAddress(address: string): boolean {
  const value = normalizeHost(address);
  const version = isIP(value);
  if (version === 4) return PRIVATE_IPV4.some((pattern) => pattern.test(value));
  if (version === 6) return PRIVATE_IPV6.test(value);
  return false;
}

export function isLoopbackOrPrivateHost(host: string): boolean {
  const value = normalizeHost(host);
  return value === 'localhost' || isPrivateAddress(value);
}

interface ConfigInput {
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: boolean | null;
  readonly username: string | null;
  readonly mailFrom: string | null;
  readonly siteUrl: string | null;
}

const mailerField = {
  SMTP_HOST: 'host',
  SMTP_PORT: 'port',
  SMTP_SECURE: 'secure',
  SMTP_USER: 'username',
  SMTP_PASS: 'password',
  MAIL_FROM: 'mailFrom',
  APP_PUBLIC_URL: 'siteUrl',
} as const satisfies Record<string, keyof ConfigInput | 'password'>;

/**
 * PUT 与测试共用的校验：
 * - 字段规则直接复用 `@fs-billing/mailer` 的 `refineMailEnvironment`（不复制规则）；
 * - `enabled` / 测试要求 host、port、secure、mailFrom 必填；
 * - 端口只允许 25/465/587/2525，开发环境（Mailpit）例外；
 * - 生产环境拒绝 localhost、回环与私网 IP 字面量（域名解析检查只在测试接口做）。
 */
function validateConfig(
  input: ConfigInput,
  options: {
    readonly requireComplete: boolean;
    readonly allowPlaintext: boolean;
    /** 请求没带密码但允许沿用旧密文时，给 mailer 一个占位，避免误报“有账号没密码”。 */
    readonly passwordForValidation: string | undefined;
  },
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (options.requireComplete) {
    if (input.host === null)
      issues.push({
        path: ['host'],
        message: '启用邮件时必须填写服务器地址',
      });
    if (input.port === null)
      issues.push({
        path: ['port'],
        message: '启用邮件时必须填写端口',
      });
    if (input.secure === null)
      issues.push({
        path: ['secure'],
        message: '启用邮件时必须选择加密方式',
      });
    if (input.mailFrom === null)
      issues.push({
        path: ['mailFrom'],
        message: '启用邮件时必须填写发件人邮箱',
      });
    if (issues.length > 0) return issues;
  }

  const parsed = mailEnvironmentSchema.safeParse({
    SMTP_HOST: input.host ?? undefined,
    SMTP_PORT: input.port ?? undefined,
    SMTP_SECURE: input.secure === null ? undefined : String(input.secure),
    SMTP_USER: input.username ?? undefined,
    SMTP_PASS: options.passwordForValidation,
    MAIL_FROM: input.mailFrom ?? undefined,
    APP_PUBLIC_URL: input.siteUrl ?? undefined,
  });
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field =
        mailerField[String(issue.path[0]) as keyof typeof mailerField];
      issues.push({ path: field ? [field] : [], message: issue.message });
    }

  if (
    input.port !== null &&
    !options.allowPlaintext &&
    !ALLOWED_PORTS.has(input.port)
  )
    issues.push({
      path: ['port'],
      message: '端口只允许 25、465、587 或 2525',
    });

  return issues;
}

function validationFailure(issues: ValidationIssue[]): never {
  if (issues.length > 0)
    throw new ApiFailure('VALIDATION_ERROR', undefined, issues);
  throw new Error('unreachable');
}

/** 生产环境拒绝 localhost、回环与私网 IP 字面量；域名解析检查只在测试接口做。 */
function assertHostLiteralAllowed(
  host: string | null,
  allowPlaintext: boolean,
): void {
  if (host !== null && !allowPlaintext && isLoopbackOrPrivateHost(host))
    throw new AdminServiceError(
      'MAIL_SETTINGS_HOST_NOT_ALLOWED',
      '邮件服务器地址不被允许',
    );
}

const toIso = (value: Date | null): string | null =>
  value?.toISOString() ?? null;

function sourceOf(
  managed: boolean,
  env: AdminMailSettingsEnvironment,
): MailSettingsSource {
  if (managed) return 'page';
  return env.host !== null && env.mailFrom !== null ? 'env' : 'none';
}

/** 与告警设置页同一个口径：页面接管时看 `enabled`，否则看环境变量是否配了主机与发件人。 */
export async function resolveMailEnabled(
  db: Db,
  runtime: Pick<MailSettingsRuntime, 'env'>,
): Promise<boolean> {
  const record = await readEffectiveMailRecord(db);
  if (record.managed) return record.enabled;
  return runtime.env.host !== null && runtime.env.mailFrom !== null;
}

function passwordUsable(
  ciphertext: string | null,
  key: Buffer | undefined,
): boolean {
  if (ciphertext === null) return true;
  if (key === undefined) return false;
  try {
    decryptSetting(ciphertext, key, SMTP_PASSWORD_AAD);
    return true;
  } catch (error) {
    if (!(error instanceof SettingsDecryptError)) throw error;
    return false;
  }
}

async function view(
  db: Db,
  runtime: MailSettingsRuntime,
): Promise<AdminMailSettingsResponse> {
  const [record, delivery] = await Promise.all([
    readEffectiveMailRecord(db),
    readMailDeliveryStatus(db),
  ]);
  return {
    managed: record.managed,
    enabled: record.enabled,
    host: record.host,
    port: record.port,
    secure: record.secure,
    username: record.username,
    passwordSet: record.passwordCiphertext !== null,
    mailFrom: record.mailFrom,
    siteUrl: record.siteUrl,
    version: record.version,
    lastTestAt: toIso(record.lastTestAt),
    lastTestOk: record.lastTestOk,
    lastTestResult: record.lastTestResult,
    source: sourceOf(record.managed, runtime.env),
    env: { ...runtime.env },
    keyConfigured: runtime.key !== undefined,
    passwordUsable: passwordUsable(record.passwordCiphertext, runtime.key),
    allowPlaintext: runtime.allowPlaintext,
    delivery: {
      lastSentAt: toIso(delivery.lastSentAt),
      pendingCount: delivery.pendingCount,
      lastAttemptFailed: delivery.lastAttemptFailed,
    } satisfies AdminMailDelivery,
  };
}

export function readMailSettings(
  db: Db,
  runtime: MailSettingsRuntime,
): Promise<AdminMailSettingsResponse> {
  return view(db, runtime);
}

const normalizedPassword = (
  password: string | undefined,
): string | undefined => (password === '' ? undefined : password);

export async function updateMailSettingsFromApi(
  db: Db,
  actor: AuditActor,
  runtime: MailSettingsRuntime,
  request: AdminMailSettingsUpdateRequest,
): Promise<AdminMailSettingsResponse & { auditId: string | null }> {
  const current = await readEffectiveMailRecord(db);
  const password = normalizedPassword(request.password);
  if (
    requiresNewPassword(
      {
        host: current.host,
        username: current.username,
        passwordSet: current.passwordCiphertext !== null,
      },
      { host: request.host, username: request.username },
    ) &&
    password === undefined
  )
    throw new AdminServiceError(
      'MAIL_SETTINGS_PASSWORD_REQUIRED',
      '修改服务器或账号后必须重新填写密码',
    );
  if (password !== undefined && runtime.key === undefined)
    throw new AdminServiceError(
      'SETTINGS_KEY_MISSING',
      '服务器未配置 SETTINGS_ENCRYPTION_KEY，无法保存密码',
    );

  const issues = validateConfig(
    {
      enabled: request.enabled,
      host: request.host,
      port: request.port,
      secure: request.secure,
      username: request.username,
      mailFrom: request.mailFrom,
      siteUrl: request.siteUrl,
    },
    {
      requireComplete: request.enabled,
      allowPlaintext: runtime.allowPlaintext,
      passwordForValidation:
        password ?? (request.username === null ? undefined : 'stored-password'),
    },
  );
  if (issues.length > 0) validationFailure(issues);
  assertHostLiteralAllowed(request.host, runtime.allowPlaintext);

  const result = await updateMailSettings(db, {
    actor,
    key: runtime.key,
    expectedVersion: request.expectedVersion,
    input: {
      enabled: request.enabled,
      host: request.host,
      port: request.port,
      secure: request.secure,
      username: request.username,
      password,
      mailFrom: request.mailFrom,
      siteUrl: request.siteUrl,
    },
  });
  return { ...(await view(db, runtime)), auditId: result.auditId };
}

export async function testMailSettings(
  db: Db,
  actor: AuditActor,
  runtime: MailSettingsRuntime,
  request: AdminMailSettingsTestRequest,
): Promise<AdminMailSettingsTestResponse> {
  const current = await readEffectiveMailRecord(db);
  const password = normalizedPassword(request.password);
  if (
    password === undefined &&
    requiresNewPassword(
      {
        host: current.host,
        username: current.username,
        passwordSet: current.passwordCiphertext !== null,
      },
      { host: request.host, username: request.username },
    )
  )
    throw new AdminServiceError(
      'MAIL_SETTINGS_PASSWORD_REQUIRED',
      '修改服务器或账号后必须重新填写密码',
    );

  let pass = password;
  if (pass === undefined && current.passwordCiphertext !== null) {
    if (runtime.key === undefined)
      throw new AdminServiceError(
        'SETTINGS_KEY_MISSING',
        '服务器未配置 SETTINGS_ENCRYPTION_KEY，无法使用已保存的密码',
      );
    try {
      pass = decryptSetting(
        current.passwordCiphertext,
        runtime.key,
        SMTP_PASSWORD_AAD,
      );
    } catch (error) {
      if (!(error instanceof SettingsDecryptError)) throw error;
      throw new AdminServiceError(
        'MAIL_SETTINGS_PASSWORD_UNUSABLE',
        '已保存的密码无法解密，请重新填写密码',
      );
    }
  }

  const issues = validateConfig(
    {
      enabled: request.enabled,
      host: request.host,
      port: request.port,
      secure: request.secure,
      username: request.username,
      mailFrom: request.mailFrom,
      siteUrl: request.siteUrl,
    },
    {
      requireComplete: true,
      allowPlaintext: runtime.allowPlaintext,
      passwordForValidation:
        pass ?? (request.username === null ? undefined : 'stored-password'),
    },
  );
  if (issues.length > 0) validationFailure(issues);
  assertHostLiteralAllowed(request.host, runtime.allowPlaintext);

  // 生产环境：域名先解析，任一结果落在回环/私网就拒绝。保存不触发网络，只有测试接口解析。
  if (!runtime.allowPlaintext && request.host !== null) {
    const host = normalizeHost(request.host);
    if (isIP(host) === 0) {
      const resolve = runtime.lookupHost ?? defaultLookupHost;
      let addresses: readonly { address: string }[];
      try {
        addresses = await resolve(host);
      } catch {
        // 无法确认解析结果时按拒绝处理，避免绕过。
        throw new AdminServiceError(
          'MAIL_SETTINGS_HOST_NOT_ALLOWED',
          '邮件服务器地址不被允许',
        );
      }
      if (addresses.some((entry) => isPrivateAddress(entry.address)))
        throw new AdminServiceError(
          'MAIL_SETTINGS_HOST_NOT_ALLOWED',
          '邮件服务器地址不被允许',
        );
    }
  }

  const settings: MailSettings = {
    host: request.host!,
    port: request.port!,
    secure: request.secure!,
    user: request.username ?? undefined,
    pass,
    from: request.mailFrom!,
    timeoutMs: runtime.timeoutMs,
    ratePerTick: 1,
    maxAttempts: 1,
    siteUrl: request.siteUrl ?? undefined,
  };
  const transport = (runtime.transportFactory ?? defaultTransportFactory)(
    settings,
  );
  let result: MailTestResult;
  try {
    const rendered = renderMail('test', { sentAt: new Date().toISOString() });
    const sent = await transport.send({
      messageId: testMessageId(),
      from: { name: MAIL_FROM_NAME, address: settings.from },
      to: [request.to],
      ...rendered,
    });
    result = sent.accepted.length > 0 ? 'ok' : 'permanent';
  } catch (error) {
    result = classifySmtpError(error).class;
  } finally {
    transport.close();
  }
  await recordMailSettingsTest(db, { actor, to: request.to, result });
  return { ok: result === 'ok', result };
}
