import { sql } from 'drizzle-orm';
import { CDR_VALIDATION_FAILURE_PREFIX } from '@fs-billing/shared';
import { cdrTimestamp } from '../cdr-query.js';
import { withAdmin, type Db, type Tx } from '../client.js';
import { admins, tenants } from '../schema.js';
import { reasonLabel } from './classify.js';
import { withinOneEdit } from './suggest.js';
import { ASSIGNABLE_REASONS } from './types.js';

export interface UnassignedGroup {
  /** 空串表示标签为空。 */
  readonly tag: string;
  readonly count: number;
  readonly reasons: readonly { reason: string; count: number }[];
  readonly suggestedTenants: readonly {
    id: string;
    code: string;
    name: string;
  }[];
}

export interface UnassignedGroups {
  readonly total: number;
  readonly groups: readonly UnassignedGroup[];
}

const VALIDATION_LABEL = reasonLabel(CDR_VALIDATION_FAILURE_PREFIX);

/**
 * 待处理话单按标签分组（条数降序），每组带原因分布和相近租户（标签与租户编码编辑距离 ≤ 1，忽略大小写）。
 * 校验失败的原因带每行不同的明细，在数据库里就合成一类，免得 10 万行产生很多分组行。
 * 走 unassigned_cdrs_status_tag；10 万行 41 组约 20 ms（docs/evidence/phase-8）。
 */
export function readUnassignedGroups(db: Db | Tx): Promise<UnassignedGroups> {
  return withAdmin(db, async (tx) => {
    const { rows } = await tx.execute<{
      tag: string;
      reason: string;
      count: number;
    }>(sql`
      select tenant_tag as tag,
        case when starts_with(reason, ${CDR_VALIDATION_FAILURE_PREFIX})
          then ${VALIDATION_LABEL} else reason end as reason,
        count(*)::int as count
      from unassigned_cdrs
      where status = 'pending'
      group by 1, 2`);
    const byTag = new Map<
      string,
      { count: number; reasons: { reason: string; count: number }[] }
    >();
    for (const row of rows) {
      const group = byTag.get(row.tag) ?? { count: 0, reasons: [] };
      group.count += row.count;
      group.reasons.push({ reason: row.reason, count: row.count });
      byTag.set(row.tag, group);
    }
    const candidates =
      byTag.size === 0
        ? []
        : await tx
            .select({ id: tenants.id, code: tenants.code, name: tenants.name })
            .from(tenants);
    const groups = [...byTag]
      .map(([tag, group]): UnassignedGroup => ({
        tag,
        count: group.count,
        reasons: group.reasons.sort(
          (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
        ),
        suggestedTenants:
          tag === ''
            ? []
            : candidates
                .filter((tenant) => withinOneEdit(tag, tenant.code))
                .sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    return {
      total: groups.reduce((sum, group) => sum + group.count, 0),
      groups,
    };
  });
}

export function readUnassignedSummary(
  db: Db | Tx,
): Promise<{ pending: number; ignored: number }> {
  return withAdmin(db, async (tx) => {
    const { rows } = await tx.execute<{ status: string; count: number }>(sql`
      select status, count(*)::int as count from unassigned_cdrs
      where status in ('pending', 'ignored') group by status`);
    const count = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return { pending: count('pending'), ignored: count('ignored') };
  });
}

/** 时间是 ISO 8601（UTC，毫秒）：原生 SQL 的 timestamptz 不经驱动解析，由数据库格式化。 */
export interface UnassignedListRow {
  readonly id: string;
  readonly callUuid: string | null;
  readonly time: string | null;
  readonly receivedAt: string;
  readonly tag: string;
  readonly caller: string;
  readonly callee: string;
  readonly durationSeconds: number;
  readonly reason: string;
  readonly assignable: boolean;
  readonly pushCount: number;
  readonly ignore: {
    readonly reason: string;
    readonly by: { id: string; name: string } | null;
    readonly at: string | null;
  } | null;
}

export interface UnassignedList {
  readonly status: 'pending' | 'ignored' | 'superseded';
  readonly items: readonly UnassignedListRow[];
  readonly total: number;
}

/**
 * 分页列表，按接通时间（未接通取开始时间）降序，走 unassigned_cdrs_status_time。
 * assignable 与分配预览同一个判定（决定 35）：有通话身份、有计费号码、原因是可分配的三种之一。
 */
export function listUnassigned(
  db: Db | Tx,
  input: {
    status: 'pending' | 'ignored' | 'superseded';
    tag?: string | undefined;
    page: number;
    pageSize: number;
  },
): Promise<UnassignedList> {
  return withAdmin(db, async (tx) => {
    const tagFilter =
      input.tag === undefined ? sql`` : sql`and u.tenant_tag = ${input.tag}`;
    const total = await tx.execute<{ count: number }>(sql`
      select count(*)::int as count from unassigned_cdrs u
      where u.status = ${input.status} ${tagFilter}`);
    const { rows } = await tx.execute<{
      id: string;
      call_uuid: string | null;
      time: string | null;
      received_at: string;
      tag: string;
      caller: string;
      callee: string;
      duration_seconds: number;
      reason: string;
      billing_number: string | null;
      push_count: number;
      ignore_reason: string | null;
      resolved_at: string | null;
      admin_id: string | null;
      admin_name: string | null;
    }>(sql`
      select u.id, u.call_uuid, ${cdrTimestamp(sql`u.time`)} as time,
        ${cdrTimestamp(sql`u.received_at`)} as received_at, u.tenant_tag as tag, u.caller, u.callee, u.duration_seconds,
        u.reason, u.billing_number, u.push_count, u.ignore_reason, ${cdrTimestamp(sql`u.resolved_at`)} as resolved_at,
        a.id as admin_id, a.name as admin_name
      from (
        select u.*, coalesce(u.answered_at, u.started_at) as time from unassigned_cdrs u
        where u.status = ${input.status} ${tagFilter}
        order by coalesce(u.answered_at, u.started_at) desc, u.id
        limit ${input.pageSize} offset ${(input.page - 1) * input.pageSize}
      ) u
      left join ${admins} a on a.id = u.resolved_by and u.status = 'ignored'
      order by u.time desc, u.id`);
    return {
      status: input.status,
      total: total.rows[0]?.count ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        callUuid: row.call_uuid,
        time: row.time,
        receivedAt: row.received_at,
        tag: row.tag,
        caller: row.caller,
        callee: row.callee,
        durationSeconds: row.duration_seconds,
        reason: row.reason,
        assignable:
          row.call_uuid !== null &&
          row.billing_number !== null &&
          ASSIGNABLE_REASONS.includes(row.reason),
        pushCount: row.push_count,
        ignore:
          input.status === 'ignored'
            ? {
                reason: row.ignore_reason ?? '',
                by:
                  row.admin_id !== null && row.admin_name !== null
                    ? { id: row.admin_id, name: row.admin_name }
                    : null,
                at: row.resolved_at,
              }
            : null,
      })),
    };
  });
}
