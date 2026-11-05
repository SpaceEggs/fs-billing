import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AuditActor, AuditChange } from '@fs-billing/shared';
import { databaseNow } from '../clock.js';
import { withAdmin, withSystem, type Db, type Tx } from '../client.js';
import { emailOutbox, smtpSettings } from '../schema.js';
import {
  encryptSetting,
  SettingsKeyError,
  SMTP_PASSWORD_AAD,
} from '../settings-crypto.js';
import { writeAudit } from './audit.js';

/**
 * 邮箱设置的数据层：管理员作用域的读写与操作日志。
 *
 * 设计：`docs/smtp-settings-design.md`。这个 PR 只做数据层，不接 Worker、不加 API、不改页面。
 *
 * **密码规则：** 已保存密文时，只有 `host` 和 `username` 都没变才允许不填密码沿用旧密文；这两项变了必须
 * 重新输入，否则任何管理员都能把服务器改成自己的主机，把已存密码发出去。回环地址且用户名为空是开发用
 * Mailpit 的例外。明文和密文都不进返回值、操作日志或错误信息。
 */

/** 最近一次测试的结果分类；只存分类，不存服务器原始响应。 */
export const mailTestResults = ['ok', 'auth', 'retry', 'permanent'] as const;
export type MailTestResult = (typeof mailTestResults)[number];

/** 管理员读到的设置：永远没有明文，也不把密文交给调用方，只给 `passwordSet`。 */
export interface MailSettings {
  readonly managed: boolean;
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: boolean | null;
  readonly username: string | null;
  readonly passwordSet: boolean;
  readonly mailFrom: string | null;
  readonly siteUrl: string | null;
  readonly lastTestAt: Date | null;
  readonly lastTestOk: boolean | null;
  readonly lastTestResult: MailTestResult | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

/**
 * 系统作用域读到的整行（含密文）。给 Worker 与 API 的密码检查用。
 *
 * 调用方负责用 `decryptSetting` 解密 `passwordCiphertext`；**不得记录**这个字段，也不得把它放进任何
 * 响应或错误信息。解不开时按设计不发信、不回退环境变量。
 */
export interface EffectiveMailRecord {
  readonly managed: boolean;
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: boolean | null;
  readonly username: string | null;
  readonly passwordCiphertext: string | null;
  readonly mailFrom: string | null;
  readonly siteUrl: string | null;
  readonly lastTestAt: Date | null;
  readonly lastTestOk: boolean | null;
  readonly lastTestResult: MailTestResult | null;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedBy: string | null;
}

export interface MailSettingsInput {
  readonly enabled: boolean;
  readonly host: string | null;
  readonly port: number | null;
  readonly secure: boolean | null;
  readonly username: string | null;
  /** `undefined`（或空字符串）表示沿用已存密码；只有 host 与 username 都没变时才允许。 */
  readonly password?: string | undefined;
  readonly mailFrom: string | null;
  readonly siteUrl: string | null;
}

export interface UpdateMailSettingsInput {
  readonly actor: AuditActor;
  /**
   * `SETTINGS_ENCRYPTION_KEY` 解析后的 32 字节密钥；只有提供新密码时才需要。
   * 不提供新密码（沿用旧密文或只改站点地址）时可以是 `undefined`。
   */
  readonly key: Buffer | undefined;
  readonly expectedVersion: number;
  readonly input: MailSettingsInput;
}

export interface UpdateMailSettingsResult {
  readonly settings: MailSettings;
  /** 内容没变且已由页面管理时不保存、不写日志，为 null。 */
  readonly auditId: string | null;
}

/** 保存时的 expectedVersion 与当前版本不符（API 映射为 409）。 */
export class MailSettingsVersionConflictError extends Error {
  readonly code = 'MAIL_SETTINGS_VERSION_CONFLICT';
  constructor(readonly currentVersion: number) {
    super('邮箱设置已被其他人修改，请刷新后重试');
    this.name = 'MailSettingsVersionConflictError';
  }
}

/** 已存密文且 `host` 或 `username` 变了，却没有提供新密码。 */
export class MailSettingsPasswordRequiredError extends Error {
  readonly code = 'MAIL_SETTINGS_PASSWORD_REQUIRED';
  constructor() {
    super('修改服务器或账号后必须重新填写密码');
    this.name = 'MailSettingsPasswordRequiredError';
  }
}

type MailSettingsRow = typeof smtpSettings.$inferSelect;

const toMailSettings = (row: MailSettingsRow): MailSettings => ({
  managed: row.managed,
  enabled: row.enabled,
  host: row.host,
  port: row.port,
  secure: row.secure,
  username: row.username,
  passwordSet: row.passwordCiphertext !== null,
  mailFrom: row.mailFrom,
  siteUrl: row.siteUrl,
  lastTestAt: row.lastTestAt,
  lastTestOk: row.lastTestOk,
  lastTestResult: row.lastTestResult,
  version: row.version,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

const toEffectiveRecord = (row: MailSettingsRow): EffectiveMailRecord => ({
  managed: row.managed,
  enabled: row.enabled,
  host: row.host,
  port: row.port,
  secure: row.secure,
  username: row.username,
  passwordCiphertext: row.passwordCiphertext,
  mailFrom: row.mailFrom,
  siteUrl: row.siteUrl,
  lastTestAt: row.lastTestAt,
  lastTestOk: row.lastTestOk,
  lastTestResult: row.lastTestResult,
  version: row.version,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

async function readMailSettingsRow(tx: Tx): Promise<MailSettingsRow> {
  const [row] = await tx.select().from(smtpSettings).limit(1);
  // 迁移插入唯一的一行；缺失说明迁移没跑完，不静默当成默认值保存。
  if (!row) throw new Error('邮箱设置行缺失，迁移可能未完成');
  return row;
}

/** 读管理员可见的邮箱设置（不含密文）。 */
export function getMailSettings(db: Db | Tx): Promise<MailSettings> {
  return withAdmin(db, async (tx) =>
    toMailSettings(await readMailSettingsRow(tx)),
  );
}

export interface MailDeliveryStatus {
  /** `email_outbox` 里最新一封成功发送的 `sent_at`；没有发送记录为 null。 */
  readonly lastSentAt: Date | null;
  /** 等待发送的封数（`status = 'pending'`）。 */
  readonly pendingCount: number;
  /**
   * 最近一次发送尝试是否失败：最新一条 `attempts > 0` 的行是 failed，或仍在等待重试（上一次 attempt
   * 留下了 `last_error`）。没有尝试过为 false。
   */
  readonly lastAttemptFailed: boolean;
}

/** 发件箱概况（管理员作用域）；只读，不返回正文或收件人。 */
export function readMailDeliveryStatus(
  db: Db | Tx,
): Promise<MailDeliveryStatus> {
  return withAdmin(db, async (tx) => {
    const [sent] = await tx
      .select({ at: emailOutbox.sentAt })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, 'sent'))
      .orderBy(desc(emailOutbox.sentAt))
      .limit(1);
    const [pending] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(emailOutbox)
      .where(eq(emailOutbox.status, 'pending'));
    const [latest] = await tx
      .select({
        status: emailOutbox.status,
        lastError: emailOutbox.lastError,
      })
      .from(emailOutbox)
      .where(sql`${emailOutbox.attempts} > 0`)
      .orderBy(
        desc(
          sql`coalesce(${emailOutbox.sentAt}, ${emailOutbox.nextAttemptAt}, ${emailOutbox.createdAt})`,
        ),
      )
      .limit(1);
    const lastAttemptFailed =
      latest !== undefined &&
      (latest.status === 'failed' ||
        ((latest.status === 'pending' || latest.status === 'sending') &&
          latest.lastError !== null));
    return {
      lastSentAt: sent?.at ?? null,
      pendingCount: pending?.count ?? 0,
      lastAttemptFailed,
    };
  });
}

/**
 * 系统作用域读取整行，含 `passwordCiphertext`。给 Worker 与 API 的密码检查用；调用方负责解密，
 * 且不得记录密文或把它放进响应。
 */
export function readEffectiveMailRecord(
  db: Db | Tx,
): Promise<EffectiveMailRecord> {
  return withSystem(db, async (tx) =>
    toEffectiveRecord(await readMailSettingsRow(tx)),
  );
}

const normalizeHost = (host: string | null): string =>
  (host ?? '').trim().toLowerCase();

/** `localhost`、`127.0.0.0/8`、`::1` 视为回环地址（开发用 Mailpit）。 */
export function isLoopbackMailHost(host: string | null): boolean {
  const value = normalizeHost(host);
  if (value === 'localhost' || value === '::1' || value === '[::1]')
    return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

export interface MailPasswordState {
  readonly host: string | null;
  readonly username: string | null;
  readonly passwordSet: boolean;
}

export interface MailPasswordTarget {
  readonly host: string | null;
  readonly username: string | null;
}

/**
 * 保存时是否必须提供新密码：
 * - 回环地址且用户名为空（开发用 Mailpit）不需要；
 * - 还没有密文时需要；
 * - 已有密文但 `host`（忽略大小写）或 `username` 变了时需要。
 */
export function requiresNewPassword(
  current: MailPasswordState,
  next: MailPasswordTarget,
): boolean {
  if (isLoopbackMailHost(next.host) && (next.username ?? '') === '')
    return false;
  if (!current.passwordSet) return true;
  return (
    normalizeHost(current.host) !== normalizeHost(next.host) ||
    (current.username ?? '') !== (next.username ?? '')
  );
}

/**
 * 保存邮箱设置并写 `mail_settings_update` 操作日志（同一事务）。保存时把 `managed` 设为 true。
 *
 * - 版本不符抛 {@link MailSettingsVersionConflictError}，不写日志；
 * - 内容没变且 `managed` 已是 true：不加版本、不写日志，返回当前设置与 `auditId: null`；
 * - `host` / `username` 变了却没给新密码，抛 {@link MailSettingsPasswordRequiredError}，不写日志。
 *
 * 密码只写固定文字（已设置 / 未设置 / 已更改），明文与密文都不进操作日志。
 */
export function updateMailSettings(
  db: Db | Tx,
  { actor, key, expectedVersion, input }: UpdateMailSettingsInput,
): Promise<UpdateMailSettingsResult> {
  return withAdmin(db, async (tx) => {
    const current = await readMailSettingsRow(tx);
    if (current.version !== expectedVersion)
      throw new MailSettingsVersionConflictError(current.version);

    const password = input.password === '' ? undefined : input.password;
    const passwordProvided = password !== undefined;
    if (
      requiresNewPassword(
        {
          host: current.host,
          username: current.username,
          passwordSet: current.passwordCiphertext !== null,
        },
        { host: input.host, username: input.username },
      ) &&
      !passwordProvided
    )
      throw new MailSettingsPasswordRequiredError();

    const hostUnchanged =
      normalizeHost(current.host) === normalizeHost(input.host);
    const changed =
      !current.managed ||
      current.enabled !== input.enabled ||
      !hostUnchanged ||
      current.port !== input.port ||
      current.secure !== input.secure ||
      current.username !== input.username ||
      current.mailFrom !== input.mailFrom ||
      current.siteUrl !== input.siteUrl ||
      passwordProvided;
    if (!changed) return { settings: toMailSettings(current), auditId: null };

    let passwordCiphertext: string | null;
    if (password !== undefined) {
      if (key === undefined) throw new SettingsKeyError();
      passwordCiphertext = encryptSetting(password, key, SMTP_PASSWORD_AAD);
    } else
      passwordCiphertext =
        (input.username ?? '') === '' ? null : current.passwordCiphertext;
    const [row] = await tx
      .update(smtpSettings)
      .set({
        managed: true,
        enabled: input.enabled,
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username,
        passwordCiphertext,
        mailFrom: input.mailFrom,
        siteUrl: input.siteUrl,
        version: sql`${smtpSettings.version} + 1`,
        updatedAt: sql`now()`,
        updatedBy: actor.id,
      })
      .where(
        and(
          eq(smtpSettings.id, true),
          eq(smtpSettings.version, expectedVersion),
        ),
      )
      .returning();
    if (!row) throw new MailSettingsVersionConflictError(current.version);

    const changes: AuditChange[] = [];
    const push = (
      field: AuditChange['field'],
      before: string | null,
      after: string | null,
    ) => {
      if (before !== after) changes.push({ field, before, after });
    };
    push('smtpManaged', String(current.managed), String(row.managed));
    push('smtpEnabled', String(current.enabled), String(row.enabled));
    push('smtpHost', current.host, row.host);
    push(
      'smtpPort',
      current.port === null ? null : String(current.port),
      row.port === null ? null : String(row.port),
    );
    push(
      'smtpSecure',
      current.secure === null ? null : String(current.secure),
      row.secure === null ? null : String(row.secure),
    );
    push('smtpUsername', current.username, row.username);
    if (passwordProvided)
      changes.push({
        field: 'smtpPassword',
        before: current.passwordCiphertext === null ? '未设置' : '已设置',
        after: '已更改',
      });
    push('smtpMailFrom', current.mailFrom, row.mailFrom);
    push('smtpSiteUrl', current.siteUrl, row.siteUrl);

    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor,
      occurredAt: (await databaseNow(tx)).toISOString(),
      tenantId: null,
      // 全局单行没有自己的 uuid：对象取本条审计自身的 id（同 alert_settings_update）。
      target: { kind: 'smtp_settings', id: auditId },
      action: 'mail_settings_update',
      content: {
        summary: '邮箱设置修改',
        changes,
        version: row.version,
      },
    });
    return { settings: toMailSettings(row), auditId };
  });
}

export interface RecordMailSettingsTestInput {
  readonly actor: AuditActor;
  /** 测试收件人（只记日志，不存设置表）。 */
  readonly to: string;
  readonly result: MailTestResult;
}

export interface RecordMailSettingsTestResult {
  readonly auditId: string;
  /** 测试不改设置，版本保持不变。 */
  readonly version: number;
}

/**
 * 记录最近一次测试邮件的结果并写 `mail_settings_test` 操作日志（同一事务）。
 * 只改 `last_test_*`，**不增加 version**（设置内容没变，并发保存不应因测试而冲突）。
 */
export function recordMailSettingsTest(
  db: Db | Tx,
  { actor, to, result }: RecordMailSettingsTestInput,
): Promise<RecordMailSettingsTestResult> {
  return withAdmin(db, async (tx) => {
    const at = await databaseNow(tx);
    const [row] = await tx
      .update(smtpSettings)
      .set({
        lastTestAt: at,
        lastTestOk: result === 'ok',
        lastTestResult: result,
      })
      .where(eq(smtpSettings.id, true))
      .returning({ version: smtpSettings.version });
    if (!row) throw new Error('邮箱设置行缺失，迁移可能未完成');
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor,
      occurredAt: at.toISOString(),
      tenantId: null,
      target: { kind: 'smtp_settings', id: auditId },
      action: 'mail_settings_test',
      content: {
        summary: '邮箱设置测试',
        changes: [],
        recipient: to,
        result,
      },
    });
    return { auditId, version: row.version };
  });
}
