import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from './client.js';
import { enqueueEmail, recoverAdminRecipientAlert } from './outbox.js';
import { alertSettings, systemAlerts, tenants } from './schema.js';

/**
 * 故障告警邮件：开始、汇总、恢复（阶段 9 设计「故障告警邮件」）。
 *
 * 本文件是 notify-tick 里告警通知的数据库部分：告警设置的读写，以及 {@link queueAlertNotices}——
 * 在调用方的事务里按序认领「开始、汇总、恢复」三类通知，更新告警上的通知列，并把邮件写进发件箱。
 * 认领与入队同一事务，所以每个状态变化恰好产生一封邮件；发送是之后的另一步（Worker 的分发）。
 * 所有时间都由调用方传入，测试用假时钟推进。
 *
 * **三条查询都必须带 `notify = true`。** 迁移 0020 回填后，未恢复的历史告警是 `notify = false`、
 * `notified_start_at` 有值、`notified_recovered_at` 为空；漏掉这个过滤，它们升级后第一次恢复就会发一封恢复邮件。
 */

/** 汇总邮件间隔 N 的默认值（分钟，决定 31）。 */
export const DEFAULT_ALERT_DIGEST_MINUTES = 15;
export const MAX_ALERT_RECIPIENTS = 20;
export const MAX_ALERT_DIGEST_MINUTES = 1440;
/** 一封邮件最多列多少条告警（模板参数的上限）；超出的拆成多封。 */
export const MAX_ALERTS_PER_MAIL = 200;
/** 汇总里「受影响最多的租户」的个数（决定 34）。 */
export const DIGEST_TOP_TENANTS = 5;
/**
 * `auth_timeout` 统计受影响租户时 `cdrs.started_at` 的回看范围：话单在通话结束后才推送（单通最长 4 小时，
 * Worker 停机后可能晚几天），而 cdrs 按 started_at 分区，这个下限让查询只碰最近的几个分区。
 */
export const TOP_TENANTS_LOOKBACK_DAYS = 7;
const DESCRIPTION_MAX = 2000;

/** 三种邮件的幂等键。一封邮件可以合并同一 tick 的多条告警，键取这一批里最小的告警 id。 */
export const AlertMailKeys = {
  /** 一条告警只会发一次开始邮件（`notified_start_at` 只置一次）。 */
  start: (minAlertId: string) => `alert_start:${minAlertId}`,
  /** 序号是这条告警上一封开始/汇总邮件时的 `digest_cursor`：每发一封汇总它就前进，所以同一告警的键不会重复。 */
  digest: (minAlertId: string, previousCursor: number) =>
    `alert_digest:${minAlertId}:${previousCursor}`,
  recovered: (minAlertId: string) => `alert_recovered:${minAlertId}`,
} as const;

// ---------------------------------------------------------------------------
// 告警设置
// ---------------------------------------------------------------------------

export interface AlertSettings {
  readonly recipients: string[];
  readonly digestMinutes: number;
  readonly version: number;
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** 保存时的 expectedVersion 与当前版本不符（API 映射为 409 `ALERT_SETTINGS_VERSION_CONFLICT`，PR 6）。 */
export class AlertSettingsVersionConflictError extends Error {
  readonly code = 'ALERT_SETTINGS_VERSION_CONFLICT';
  constructor(readonly currentVersion: number | undefined) {
    super('告警设置已被其他人修改，请刷新后重试');
    this.name = 'AlertSettingsVersionConflictError';
  }
}
/** 保存的内容不合法（API 层的 zod 应已拦住；这是库函数自己的底线）。 */
export class AlertSettingsInvalidError extends Error {
  readonly code = 'ALERT_SETTINGS_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'AlertSettingsInvalidError';
  }
}

const emailSchema = z.email();

/** 去空白、小写、去重（保持首次出现的顺序）；每项必须是单个纯邮箱地址，最多 20 个。规则同租户邮箱。 */
export function normalizeAlertRecipients(recipients: readonly string[]) {
  const seen = new Set<string>();
  for (const entry of recipients) {
    const address = entry.trim().toLowerCase();
    if (address === '') continue;
    if (!emailSchema.safeParse(address).success)
      throw new AlertSettingsInvalidError('接收邮箱格式不正确');
    seen.add(address);
  }
  if (seen.size > MAX_ALERT_RECIPIENTS)
    throw new AlertSettingsInvalidError(
      `接收邮箱最多 ${MAX_ALERT_RECIPIENTS} 个`,
    );
  return [...seen];
}

const toSettings = (row: typeof alertSettings.$inferSelect): AlertSettings => ({
  recipients: row.recipients,
  digestMinutes: row.digestMinutes,
  version: row.version,
  updatedAt: row.updatedAt,
  updatedBy: row.updatedBy,
});

/** 读告警设置。迁移建好唯一的一行；万一缺失按默认值（空接收邮箱、15 分钟）。 */
export async function readAlertSettings(tx: Tx): Promise<AlertSettings> {
  const [row] = await tx.select().from(alertSettings).limit(1);
  return row
    ? toSettings(row)
    : {
        recipients: [],
        digestMinutes: DEFAULT_ALERT_DIGEST_MINUTES,
        version: 1,
        updatedAt: null,
        updatedBy: null,
      };
}

export interface SaveAlertSettingsInput {
  readonly recipients: readonly string[];
  readonly digestMinutes: number;
  /** 乐观并发：必须等于当前版本，保存后版本加一。 */
  readonly expectedVersion: number;
  /** 操作的管理员（admins.id）。 */
  readonly updatedBy: string;
  /** 保存时间；默认数据库 now()。 */
  readonly at?: Date | undefined;
}
export interface SaveAlertSettingsResult {
  readonly before: AlertSettings;
  readonly after: AlertSettings;
  readonly recipientsChanged: boolean;
  /** 因接收邮箱变化而恢复的 `recipient:admin` 告警条数（0 或 1）。 */
  readonly recoveredRecipientAlerts: number;
}

/**
 * 保存告警设置（调用方在管理员事务里调用，并在同一事务写 `alert_settings_update` 操作日志，PR 6）。
 * 版本不符抛 {@link AlertSettingsVersionConflictError}。接收邮箱的列表变了，就在同一事务里恢复
 * `recipient:admin` 告警（`recoverAdminRecipientAlert`）：旧地址被拒的告警对新列表不再成立，
 * 新列表若仍被拒会重新开一条；没变的话保存设置不动它，让它按 7 天窗口恢复。
 */
export async function saveAlertSettings(
  tx: Tx,
  input: SaveAlertSettingsInput,
): Promise<SaveAlertSettingsResult> {
  const recipients = normalizeAlertRecipients(input.recipients);
  if (
    !Number.isInteger(input.digestMinutes) ||
    input.digestMinutes < 1 ||
    input.digestMinutes > MAX_ALERT_DIGEST_MINUTES
  )
    throw new AlertSettingsInvalidError(
      `汇总间隔必须是 1–${MAX_ALERT_DIGEST_MINUTES} 分钟`,
    );
  const before = await readAlertSettings(tx);
  const [row] = await tx
    .update(alertSettings)
    .set({
      recipients,
      digestMinutes: input.digestMinutes,
      version: sql`${alertSettings.version} + 1`,
      updatedAt: input.at ?? sql`now()`,
      updatedBy: input.updatedBy,
    })
    .where(
      and(
        eq(alertSettings.id, true),
        eq(alertSettings.version, input.expectedVersion),
      ),
    )
    .returning();
  if (!row) throw new AlertSettingsVersionConflictError(before.version);
  const recipientsChanged =
    before.recipients.length !== recipients.length ||
    before.recipients.some((address, index) => address !== recipients[index]);
  const recoveredRecipientAlerts = recipientsChanged
    ? await recoverAdminRecipientAlert(tx, input.at)
    : 0;
  return {
    before,
    after: toSettings(row),
    recipientsChanged,
    recoveredRecipientAlerts,
  };
}

/**
 * 管理员告警邮件的收件人：设置里的接收邮箱；为空时发给所有 `active` 管理员的登录邮箱（决定 33）。
 * 管理员邮箱经 `alert_admin_emails()`（SECURITY DEFINER）读取：Worker 是 system 作用域，读不了 admins 表和
 * `auth.lookup_user_emails`。两边都空时返回空列表，发件箱入队为 `skipped`。
 */
export async function resolveAlertRecipients(
  tx: Tx,
  settings?: Pick<AlertSettings, 'recipients'>,
): Promise<{ recipients: string[]; source: 'settings' | 'admins' }> {
  const configured = (settings ?? (await readAlertSettings(tx))).recipients;
  if (configured.length > 0)
    return { recipients: [...configured], source: 'settings' };
  const { rows } = await tx.execute<{ email: string }>(
    sql`select alert_admin_emails() as email`,
  );
  return { recipients: rows.map((row) => row.email), source: 'admins' };
}

// ---------------------------------------------------------------------------
// notify-tick：开始、汇总、恢复通知
// ---------------------------------------------------------------------------

export interface QueueAlertNoticesOptions {
  /** 本次 tick 的时间；通知列、汇总节拍、持续时长都按它算。 */
  readonly at: Date;
}
export interface QueueAlertNoticesResult {
  /** 本次认领的告警条数（一封邮件可含多条）。 */
  readonly started: number;
  readonly digested: number;
  readonly recovered: number;
  /** 入队的邮件（含已存在而没有重复写入的）。 */
  readonly emails: readonly {
    readonly template: 'alert_start' | 'alert_digest' | 'alert_recovered';
    readonly dedupeKey: string;
    readonly alerts: number;
  }[];
}

const minutesBetween = (from: Date, to: Date) =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));

const chunked = <T>(items: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
};

/**
 * 在调用方的事务里认领三类告警通知并入队（notify-tick 的第 2–4 步，先恢复再调用本函数）：
 *
 * 2. **开始**：`notify` 为真、`notified_start_at` 为空、未恢复的告警。认领即置 `notified_start_at`、`last_digest_at`，
 *    `digest_cursor := occurrences`。同一 tick 新开的合并为**一封** `alert_start`。
 *    开始即恢复的（还没来得及发开始邮件就恢复了）不满足「未恢复」，永远不会被认领：不发开始也不发恢复。
 * 3. **汇总**：已发开始邮件、未恢复，距上次开始/汇总邮件满 N 分钟，并且 `occurrences > digest_cursor`。
 *    每条告警自己的节拍，同一 tick 到期的合并为**一封** `alert_digest`，随后 `last_digest_at := at`、
 *    `digest_cursor := occurrences`。没有新增事件就不发。
 * 4. **恢复**：已发开始邮件、已恢复、`notified_recovered_at` 为空的告警合并为**一封** `alert_recovered`。
 *    同一 tick 既到期汇总又恢复的，汇总查询要求未恢复，所以只发恢复（含累计）。
 *
 * 认领前用 `FOR UPDATE`（按 id 排序）锁住这些行：并发写入的事件要么在认领之前累加（算进这次的数），
 * 要么在之后累加（留给下一封汇总）。两个 tick 同时跑，后到的等锁、再看到的行已经被认领。
 */
export async function queueAlertNotices(
  tx: Tx,
  options: QueueAlertNoticesOptions,
): Promise<QueueAlertNoticesResult> {
  const { at } = options;
  const settings = await readAlertSettings(tx);
  const digestInterval = sql`${settings.digestMinutes} * interval '1 minute'`;

  // --- 开始 ---
  const toStart = await tx
    .select({
      id: systemAlerts.id,
      kind: systemAlerts.kind,
      description: systemAlerts.description,
      startedAt: systemAlerts.startedAt,
    })
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.notify, true),
        isNull(systemAlerts.notifiedStartAt),
        isNull(systemAlerts.recoveredAt),
      ),
    )
    .orderBy(systemAlerts.id)
    .for('update');
  if (toStart.length > 0)
    await tx
      .update(systemAlerts)
      .set({
        notifiedStartAt: at,
        lastDigestAt: at,
        digestCursor: sql`${systemAlerts.occurrences}`,
      })
      .where(
        inArray(
          systemAlerts.id,
          toStart.map((alert) => alert.id),
        ),
      );

  // --- 汇总 ---
  const toDigest = await tx
    .select({
      id: systemAlerts.id,
      kind: systemAlerts.kind,
      tenantId: systemAlerts.tenantId,
      startedAt: systemAlerts.startedAt,
      occurrences: systemAlerts.occurrences,
      previousCursor: systemAlerts.digestCursor,
    })
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.notify, true),
        isNotNull(systemAlerts.notifiedStartAt),
        isNull(systemAlerts.recoveredAt),
        sql`${systemAlerts.occurrences} > ${systemAlerts.digestCursor}`,
        // 每条告警自己的节拍：从开始邮件或上一封汇总邮件算起 N 分钟。
        sql`${at}::timestamptz >= greatest(${systemAlerts.notifiedStartAt}, coalesce(${systemAlerts.lastDigestAt}, ${systemAlerts.notifiedStartAt})) + ${digestInterval}`,
        // 本 tick 刚认领的开始邮件不会同时到期（N ≥ 1 分钟），不需要额外排除。
      ),
    )
    .orderBy(systemAlerts.id)
    .for('update');
  if (toDigest.length > 0)
    await tx
      .update(systemAlerts)
      .set({ lastDigestAt: at, digestCursor: sql`${systemAlerts.occurrences}` })
      .where(
        inArray(
          systemAlerts.id,
          toDigest.map((alert) => alert.id),
        ),
      );

  // --- 恢复通知 ---
  const toRecover = await tx
    .select({
      id: systemAlerts.id,
      kind: systemAlerts.kind,
      startedAt: systemAlerts.startedAt,
      recoveredAt: systemAlerts.recoveredAt,
      occurrences: systemAlerts.occurrences,
      affectedCalls: systemAlerts.affectedCalls,
    })
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.notify, true),
        isNotNull(systemAlerts.notifiedStartAt),
        isNotNull(systemAlerts.recoveredAt),
        isNull(systemAlerts.notifiedRecoveredAt),
      ),
    )
    .orderBy(systemAlerts.id)
    .for('update');
  if (toRecover.length > 0)
    await tx
      .update(systemAlerts)
      .set({ notifiedRecoveredAt: at })
      .where(
        inArray(
          systemAlerts.id,
          toRecover.map((alert) => alert.id),
        ),
      );

  const emails: {
    template: 'alert_start' | 'alert_digest' | 'alert_recovered';
    dedupeKey: string;
    alerts: number;
  }[] = [];
  const result = (): QueueAlertNoticesResult => ({
    started: toStart.length,
    digested: toDigest.length,
    recovered: toRecover.length,
    emails,
  });
  if (toStart.length + toDigest.length + toRecover.length === 0)
    return result();

  // 认领和入队同一事务；收件人只在确有邮件要发时才读。
  const { recipients } = await resolveAlertRecipients(tx, settings);
  const send = async (
    template: 'alert_start' | 'alert_digest' | 'alert_recovered',
    dedupeKey: string,
    params: Record<string, unknown>,
    alerts: number,
  ) => {
    await enqueueEmail(tx, { dedupeKey, template, params, recipients, at });
    emails.push({ template, dedupeKey, alerts });
  };

  for (const batch of chunked(toStart, MAX_ALERTS_PER_MAIL))
    await send(
      'alert_start',
      AlertMailKeys.start(batch[0]!.id),
      {
        alerts: batch.map((alert) => ({
          kind: alert.kind,
          description: alert.description.slice(0, DESCRIPTION_MAX),
          startedAt: alert.startedAt.toISOString(),
        })),
      },
      batch.length,
    );

  if (toDigest.length > 0) {
    const tenantCodes = await tenantCodesOf(
      tx,
      toDigest.flatMap((alert) => (alert.tenantId ? [alert.tenantId] : [])),
    );
    const digestRows: {
      alert: (typeof toDigest)[number];
      topTenants: string[];
    }[] = [];
    for (const alert of toDigest)
      digestRows.push({
        alert,
        topTenants:
          alert.kind === 'auth_timeout'
            ? await topUnverifiedTenants(tx, alert.startedAt)
            : alert.tenantId && tenantCodes.has(alert.tenantId)
              ? [tenantCodes.get(alert.tenantId)!]
              : [],
      });
    for (const batch of chunked(digestRows, MAX_ALERTS_PER_MAIL))
      await send(
        'alert_digest',
        AlertMailKeys.digest(
          batch[0]!.alert.id,
          batch[0]!.alert.previousCursor,
        ),
        {
          alerts: batch.map(({ alert, topTenants }) => ({
            kind: alert.kind,
            startedAt: alert.startedAt.toISOString(),
            durationMinutes: minutesBetween(alert.startedAt, at),
            added: alert.occurrences - alert.previousCursor,
            total: alert.occurrences,
            topTenants,
          })),
        },
        batch.length,
      );
  }

  for (const batch of chunked(toRecover, MAX_ALERTS_PER_MAIL))
    await send(
      'alert_recovered',
      AlertMailKeys.recovered(batch[0]!.id),
      {
        alerts: batch.map((alert) => {
          // recovered_at 在这里一定有值（查询要求）；防御性地回退到 at。
          const recoveredAt = alert.recoveredAt ?? at;
          return {
            kind: alert.kind,
            startedAt: alert.startedAt.toISOString(),
            recoveredAt: recoveredAt.toISOString(),
            durationMinutes: minutesBetween(alert.startedAt, recoveredAt),
            total: alert.occurrences,
            affectedCalls: alert.affectedCalls,
          };
        }),
      },
      batch.length,
    );
  return result();
}

async function tenantCodesOf(
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: tenants.id, code: tenants.code })
    .from(tenants)
    .where(inArray(tenants.id, [...new Set(ids)]));
  return new Map(rows.map((row) => [row.id, row.code]));
}

/**
 * 授权超时的受影响租户：告警开始以来入库的未验证话单，按租户计数取前 5 个编码（决定 34：只给编码，不给号码和 UUID）。
 * 按 `received_at`（入库时间）而不是话单的 started_at 取，因为告警的开始时间就是第一条未验证话单入库的时间。
 * `started_at` 下限只为分区剪枝，见 {@link TOP_TENANTS_LOOKBACK_DAYS}。
 */
export async function topUnverifiedTenants(
  tx: Tx,
  since: Date,
  limit = DIGEST_TOP_TENANTS,
): Promise<string[]> {
  const { rows } = await tx.execute<{ code: string }>(sql`
    SELECT t.code
    FROM cdrs c JOIN tenants t ON t.id = c.tenant_id
    WHERE c.unverified
      AND c.received_at >= ${since}::timestamptz
      AND c.started_at >= ${since}::timestamptz - ${TOP_TENANTS_LOOKBACK_DAYS} * interval '1 day'
    GROUP BY t.code
    ORDER BY count(*) DESC, t.code
    LIMIT ${limit}`);
  return rows.map((row) => row.code);
}
