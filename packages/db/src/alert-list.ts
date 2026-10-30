import { eq, sql, type SQL } from 'drizzle-orm';
import {
  alertKindLabel,
  alertKindSchema,
  type AdminAlertWindow,
  type AdminSystemAlert,
  type AdminSystemAlertDetail,
  type AdminSystemAlertsSummaryResponse,
} from '@fs-billing/shared';
import { cdrTimestamp } from './cdr-query.js';
import { withAdmin, type Db, type Tx } from './client.js';
import { TOP_TENANTS_LOOKBACK_DAYS } from './alert-notify.js';
import { AdminServiceError } from './admin/errors.js';
import { systemAlerts } from './schema.js';

/**
 * 系统告警页与概览页共用的查询（阶段 9 设计「两个页面的数字」）。
 *
 * 「最近 24 小时」的条数在概览页和告警页是同一个数：两处都经 {@link alertsInWindow} /
 * {@link countAlertsInWindow}，谓词只写在 {@link alertWindowPredicate} 一处。
 * 时间默认取事务的 `now()`（同一事务里的几次调用口径相同）；测试传入 `now`。
 */

/** 窗口的回看长度；`all` 不限。 */
const WINDOW_INTERVAL: Record<Exclude<AdminAlertWindow, 'all'>, string> = {
  '24h': '24 hours',
  '30d': '30 days',
};
/** `auth_timeout` 详情统计受影响租户时最多回看 30 天（设计：更长的进行中告警只统计最近 30 天并注明）。 */
export const ALERT_DETAIL_MAX_DAYS = 30;
/** 详情里「受影响最多的租户」的个数。 */
export const ALERT_DETAIL_TOP_TENANTS = 5;
/** 详情里通知记录的上限。 */
export const ALERT_DETAIL_MAX_NOTICES = 50;

const instant = (now?: Date): SQL =>
  now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

/**
 * 窗口谓词：进行中的告警不论开始多久都算；已恢复的告警 `started_at` 或 `recovered_at` 落在窗口内算。
 * 列引用带别名（默认 `a`，即 `system_alerts a`）。`all` 恒真。
 */
export function alertWindowPredicate(
  window: AdminAlertWindow,
  options: { alias?: string; now?: Date } = {},
): SQL {
  if (window === 'all') return sql`true`;
  const alias = sql.raw(options.alias ?? 'a');
  const since = sql`${instant(options.now)} - ${sql.raw(`interval '${WINDOW_INTERVAL[window]}'`)}`;
  return sql`(${alias}.recovered_at is null or ${alias}.started_at >= ${since} or ${alias}.recovered_at >= ${since})`;
}

export interface AlertListFilter {
  readonly window: AdminAlertWindow;
  readonly status?: 'all' | 'open' | 'recovered' | undefined;
  readonly kind?: string | undefined;
  readonly now?: Date | undefined;
}

function alertWhere(filter: AlertListFilter): SQL {
  const conditions: SQL[] = [
    alertWindowPredicate(filter.window, {
      ...(filter.now ? { now: filter.now } : {}),
    }),
  ];
  if (filter.status === 'open') conditions.push(sql`a.recovered_at is null`);
  if (filter.status === 'recovered')
    conditions.push(sql`a.recovered_at is not null`);
  if (filter.kind) conditions.push(sql`a.kind = ${filter.kind}`);
  return sql.join(conditions, sql` and `);
}

/** 窗口内（可再按状态、类型筛选）的告警条数；列表的 `total`、概览的告警数、导航汇总都经过这里。 */
export async function countAlertsInWindow(
  tx: Tx,
  filter: AlertListFilter,
): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(
    sql`select count(*)::int as count from system_alerts a where ${alertWhere(filter)}`,
  );
  return rows[0]?.count ?? 0;
}

/** 进行中的告警总数（导航红点、告警页「进行中 N」、概览红色），不受筛选影响。 */
export async function countOpenAlerts(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ count: number }>(
    sql`select count(*)::int as count from system_alerts where recovered_at is null`,
  );
  return rows[0]?.count ?? 0;
}

type AlertRow = {
  id: string;
  kind: string;
  description: string;
  started_at: string;
  last_seen_at: string;
  recovered_at: string | null;
  duration_seconds: number;
  affected_calls: number;
  occurrences: number;
  tenant_id: string | null;
  tenant_code: string | null;
  tenant_name: string | null;
};

const selectAlertColumns = (now?: Date) => sql`
  a.id, a.kind, a.description,
  ${cdrTimestamp(sql`a.started_at`)} as started_at,
  ${cdrTimestamp(sql`a.last_seen_at`)} as last_seen_at,
  ${cdrTimestamp(sql`a.recovered_at`)} as recovered_at,
  greatest(0, floor(extract(epoch from (coalesce(a.recovered_at, ${instant(now)}) - a.started_at))))::int as duration_seconds,
  a.affected_calls, a.occurrences,
  t.id as tenant_id, t.code as tenant_code, t.name as tenant_name`;

function toAlert(row: AlertRow): AdminSystemAlert {
  const kind = alertKindSchema.parse(row.kind);
  return {
    id: row.id,
    kind,
    kindLabel: alertKindLabel(kind),
    description: row.description,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    recoveredAt: row.recovered_at,
    status: row.recovered_at === null ? 'open' : 'recovered',
    durationSeconds: row.duration_seconds,
    affectedCalls: row.affected_calls,
    occurrences: row.occurrences,
    tenant:
      row.tenant_id !== null &&
      row.tenant_code !== null &&
      row.tenant_name !== null
        ? { id: row.tenant_id, code: row.tenant_code, name: row.tenant_name }
        : null,
  };
}

export interface AlertsInWindow {
  readonly total: number;
  readonly items: readonly AdminSystemAlert[];
  /** 进行中的告警总数（不受筛选影响）。 */
  readonly openCount: number;
}

/**
 * 告警列表：窗口 + 状态 + 类型，进行中在前，然后按 `started_at` 降序。
 * 概览的「最近 24 小时」取 `{ window: '24h', pageSize: 5 }`，`total` 就是概览上的告警数。
 */
export function alertsInWindow(
  db: Db | Tx,
  input: AlertListFilter & { page?: number; pageSize?: number },
): Promise<AlertsInWindow> {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 25;
  return withAdmin(db, async (tx) => {
    const total = await countAlertsInWindow(tx, input);
    const { rows } = await tx.execute<AlertRow>(sql`
      select ${selectAlertColumns(input.now)}
      from (
        select * from system_alerts a
        where ${alertWhere(input)}
        order by (a.recovered_at is null) desc, a.started_at desc, a.id
        limit ${pageSize} offset ${(page - 1) * pageSize}
      ) a
      left join tenants t on t.id = a.tenant_id
      order by (a.recovered_at is null) desc, a.started_at desc, a.id`);
    return {
      total,
      items: rows.map(toAlert),
      openCount: await countOpenAlerts(tx),
    };
  });
}

/** 导航红点与概览用的汇总：进行中条数、最近 24 小时条数、进行中里最近一条的开始时间。 */
export function readAlertSummary(
  db: Db | Tx,
  options: { now?: Date } = {},
): Promise<AdminSystemAlertsSummaryResponse> {
  return withAdmin(db, async (tx) => {
    const { rows } = await tx.execute<{
      open: number;
      last_opened_at: string | null;
    }>(sql`
      select count(*)::int as open, ${cdrTimestamp(sql`max(started_at)`)} as last_opened_at
      from system_alerts where recovered_at is null`);
    return {
      open: rows[0]?.open ?? 0,
      last24h: await countAlertsInWindow(tx, {
        window: '24h',
        ...(options.now ? { now: options.now } : {}),
      }),
      lastOpenedAt: rows[0]?.last_opened_at ?? null,
    };
  });
}

/**
 * 告警键反推未归属话单页的筛选：`unassigned:<原因>`（租户不存在时 `unassigned:租户不存在:<标签>`）
 * 和 `invalid-cdr:<结构化原因>`（原因文本就是未归属行的 `reason`）。其他键没有对应的页面筛选。
 */
export function unassignedFilterOfKey(
  subjectKey: string | null,
): { reason: string; tag: string | null } | null {
  if (subjectKey === null) return null;
  if (subjectKey.startsWith('invalid-cdr:')) {
    const reason = subjectKey.slice('invalid-cdr:'.length);
    return reason === '' ? null : { reason, tag: null };
  }
  if (subjectKey.startsWith('unassigned:')) {
    const rest = subjectKey.slice('unassigned:'.length);
    const missing = '租户不存在:';
    if (rest.startsWith(missing))
      return { reason: '租户不存在', tag: rest.slice(missing.length) };
    return rest === '' ? null : { reason: rest, tag: null };
  }
  return null;
}

/** 告警详情。不存在抛 `AdminServiceError('NOT_FOUND')`（404）。 */
export function getAlertDetail(
  db: Db | Tx,
  alertId: string,
  options: { now?: Date } = {},
): Promise<AdminSystemAlertDetail> {
  return withAdmin(db, async (tx) => {
    // 详情的两个查询是小结果的扫描：JIT 编译的开销（PORTALBIG 形状的库上实测 130 ms）远大于收益。只影响当前事务。
    await tx.execute(sql`set local jit = off`);
    const { rows } = await tx.execute<AlertRow>(sql`
      select ${selectAlertColumns(options.now)}
      from system_alerts a left join tenants t on t.id = a.tenant_id
      where a.id = ${alertId}::uuid`);
    const row = rows[0];
    if (!row) throw new AdminServiceError('NOT_FOUND', '告警不存在');
    const alert = toAlert(row);
    // 与 queueAlertNotices 同一条读取路径取 startedAt，序列化出的字符串才和发件箱快照里的完全一致。
    const [key] = await tx
      .select({
        startedAt: systemAlerts.startedAt,
        subjectKey: systemAlerts.subjectKey,
        notify: systemAlerts.notify,
      })
      .from(systemAlerts)
      .where(eq(systemAlerts.id, alertId));
    if (!key) throw new AdminServiceError('NOT_FOUND', '告警不存在');

    const stats =
      alert.kind === 'auth_timeout'
        ? await readUnverifiedStats(tx, alertId, options.now)
        : { affectedTenants: null, cdrRange: null };
    // 邮件快照里每条告警带 id（PR 6 起）：按 id 关联；此前入队的行没有 id，退回 (kind, startedAt)。
    // 取最新的 50 封，按时间从旧到新显示。
    const startedAtText = key.startedAt.toISOString();
    const noticeRows = await tx.execute<{
      template: 'alert_start' | 'alert_digest' | 'alert_recovered';
      status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
      queued_at: string;
      sent_at: string | null;
      attempts: number;
      skip_reason: string | null;
    }>(sql`
      select template, status, queued_at, sent_at, attempts, skip_reason
      from (
        select id, template, status, created_at, ${cdrTimestamp(sql`created_at`)} as queued_at,
          ${cdrTimestamp(sql`sent_at`)} as sent_at, attempts, skip_reason
        from email_outbox
        where template in ('alert_start', 'alert_digest', 'alert_recovered')
          and created_at >= ${startedAtText}::timestamptz
          and exists (
            select 1 from jsonb_array_elements(params -> 'alerts') snapshot
            where snapshot ->> 'id' = ${alertId}
              or (not snapshot ? 'id' and snapshot ->> 'kind' = ${alert.kind}
                  and snapshot ->> 'startedAt' = ${startedAtText})
          )
        order by created_at desc, id desc
        limit ${ALERT_DETAIL_MAX_NOTICES}
      ) newest
      order by created_at, id`);
    return {
      ...alert,
      notify: key.notify,
      ...stats,
      unassignedFilter:
        alert.kind === 'cdr_failed'
          ? unassignedFilterOfKey(key.subjectKey)
          : null,
      notices: noticeRows.rows.map((notice) => ({
        template: notice.template,
        status: notice.status,
        queuedAt: notice.queued_at,
        sentAt: notice.sent_at,
        attempts: notice.attempts,
        skipReason: notice.skip_reason,
      })),
    };
  });
}

/**
 * `auth_timeout` 详情：告警期间（`received_at` 在 [开始, 恢复或现在]）入库的未验证话单，范围最长 30 天，
 * 以告警的结束（恢复时间，进行中的算现在）往前数，所以很久以前恢复的短告警也统计得到，
 * 按租户计数取前 5，加上这些话单 `started_at` 的最早最晚（北京日，供跳转租户话单标签页）。
 * `cdrs` 按 `started_at` 月分区，`unverified` / `received_at` 没有索引：`started_at` 的两侧边界
 * （下限 −7 天，上限 +1 天，同 notify-tick 的汇总统计）只为分区剪枝。一次扫描，两个结果。
 */
async function readUnverifiedStats(
  tx: Tx,
  alertId: string,
  now?: Date,
): Promise<Pick<AdminSystemAlertDetail, 'affectedTenants' | 'cdrRange'>> {
  const { rows } = await tx.execute<{
    part: 'tenant' | 'range';
    id: string | null;
    code: string | null;
    name: string | null;
    n: number;
    first: string | null;
    last: string | null;
    first_day: string | null;
    last_day: string | null;
    truncated: boolean;
  }>(sql`
    with bounds as (
      select greatest(a.started_at, e.hi - ${ALERT_DETAIL_MAX_DAYS} * interval '1 day') as lo,
        e.hi as hi,
        e.hi - a.started_at > ${ALERT_DETAIL_MAX_DAYS} * interval '1 day' as truncated
      from system_alerts a
      cross join lateral (select coalesce(a.recovered_at, ${instant(now)}) as hi) e
      where a.id = ${alertId}::uuid
    ),
    scoped as materialized (
      select c.tenant_id, c.started_at
      from cdrs c, bounds b
      where c.unverified
        and c.received_at >= b.lo and c.received_at <= b.hi
        and c.started_at >= b.lo - ${TOP_TENANTS_LOOKBACK_DAYS} * interval '1 day'
        and c.started_at <= b.hi + interval '1 day'
    ),
    agg as (
      select count(*)::int as n, min(started_at) as first, max(started_at) as last from scoped
    ),
    top as (
      select tenant_id, count(*)::int as n from scoped group by tenant_id order by n desc, tenant_id limit ${ALERT_DETAIL_TOP_TENANTS}
    )
    select 'tenant' as part, t.id, t.code, t.name, top.n, null::text as first, null::text as last,
      null::text as first_day, null::text as last_day, (select truncated from bounds) as truncated
    from top join tenants t on t.id = top.tenant_id
    union all
    select 'range', null, null, null, agg.n, ${cdrTimestamp(sql`agg.first`)}, ${cdrTimestamp(sql`agg.last`)},
      to_char(agg.first at time zone 'Asia/Shanghai', 'YYYY-MM-DD'), to_char(agg.last at time zone 'Asia/Shanghai', 'YYYY-MM-DD'),
      (select truncated from bounds)
    from agg
    order by part desc, n desc, code`);
  const range = rows.find((row) => row.part === 'range');
  const tenantRows = rows.filter((row) => row.part === 'tenant');
  return {
    affectedTenants: {
      items: tenantRows.map((row) => ({
        id: row.id!,
        code: row.code!,
        name: row.name!,
        count: row.n,
      })),
      truncated: range?.truncated ?? false,
    },
    cdrRange:
      range?.first && range.last && range.first_day && range.last_day
        ? {
            from: range.first,
            to: range.last,
            fromDay: range.first_day,
            toDay: range.last_day,
          }
        : null,
  };
}
