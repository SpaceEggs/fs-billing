import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CDR_PAGE_SIZE,
  adminCdrExportRequestSchema,
  adminCdrsQuerySchema,
  adminCdrsResponseSchema,
  type AdminCdrExportRequest,
  type AdminCdrsQuery,
  type AuditActor,
  type AuditPayload,
} from '@fs-billing/shared';
import { listCountries, portalCdrProjection } from '../portal/cdrs.js';
import { withAdmin, type Db, type PoolDb, type Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import {
  adminCdrFilters,
  cdrBounds,
  cdrTimestamp,
  type AdminCdrFilter,
} from '../cdr-query.js';
import { writeAudit } from './audit.js';
import * as schema from '../schema.js';
import { cancelPostgresBackend } from '../cancel-postgres.js';
import { withBoundedExportClient } from '../bounded-export-client.js';

export function listAdminCdrs({
  db,
  tenantId,
  query,
}: {
  db: Db;
  tenantId: string;
  query: AdminCdrsQuery;
}) {
  const input = adminCdrsQuerySchema.parse(query);
  const filters = adminCdrFilters({ tenantId, query: input });
  return withAdmin(db, async (tx) => {
    const { rows } = await tx.execute<{ response: unknown }>(sql`
      with ${cdrBounds(input)},
      filtered as (
        select c.call_uuid, c.started_at, c.answered_at, c.ended_at,
          c.caller, c.callee, c.country, c.iso, c.description, c.matched_prefix, c.duration_seconds,
          c.billed_minutes, c.rate, c.charge, c.hangup_cause, c.unverified
        from cdrs c where ${filters}
      ),
      stats as (
        select count(*)::int as total,
          coalesce(sum(billed_minutes), 0)::text as billed_minutes,
          coalesce(sum(charge), 0)::text as charge,
          count(*) filter (where answered_at is null)::int as unanswered,
          count(*) filter (where unverified)::int as unverified
        from filtered
      ),
      hidden_unanswered as (
        select count(*)::int as total from cdrs c
        where ${
          input.status === 'answered' && !input.country
            ? sql`c.tenant_id = ${tenantId}::uuid and c.answered_at is null
              and c.started_at >= (select lo from bounds)
              and c.started_at < (select hi from bounds)
              and c.started_at >= (select lo from bounds) - interval '31 days'
              and c.started_at < (select hi from bounds)
              ${input.callee ? sql`and c.billing_number like ${`%${input.callee}%`}` : sql``}
              ${input.unverifiedOnly ? sql`and c.unverified` : sql``}`
            : sql`false`
        }
      ),
      page as (
        select c.call_uuid, c.started_at, c.answered_at, c.ended_at,
          c.caller, c.callee, c.country, c.iso, c.description, c.matched_prefix, c.duration_seconds,
          c.billed_minutes, c.rate, c.charge, c.hangup_cause, c.unverified
        from filtered c
        order by ${
          input.status === 'all'
            ? sql`coalesce(c.answered_at, c.started_at)`
            : sql`c.answered_at`
        } desc, c.call_uuid desc
        limit ${CDR_PAGE_SIZE} offset ${(input.page - 1) * CDR_PAGE_SIZE}
      )
      select jsonb_build_object(
        'currency', (select currency from tenants where id = ${tenantId}::uuid),
        'items', coalesce((select jsonb_agg(
          ${portalCdrProjection('p')} || jsonb_build_object('unverified', p.unverified)
          order by ${
            input.status === 'all'
              ? sql`coalesce(p.answered_at, p.started_at)`
              : sql`p.answered_at`
          } desc, p.call_uuid desc
        ) from page p), '[]'::jsonb),
        'pagination', jsonb_build_object('page', ${input.page}::int,
          'pageSize', ${CDR_PAGE_SIZE}::int, 'total', stats.total),
        'summary', jsonb_build_object('billedMinutes', stats.billed_minutes,
          'charge', stats.charge,
          'unansweredCalls', case when ${input.status} = 'all' then stats.unanswered else hidden_unanswered.total end,
          'unverifiedCalls', stats.unverified)
      ) as response
      from stats cross join hidden_unanswered
    `);
    const response = rows[0]?.response;
    if (
      !response ||
      (typeof response === 'object' &&
        response !== null &&
        'currency' in response &&
        response.currency === null)
    )
      throw new NotFoundError('租户不存在');
    return adminCdrsResponseSchema.parse({
      ...response,
      deletedMonths: await deletedMonthsIn(tx, tenantId, input),
    });
  });
}

/**
 * 与日期范围相交的、话单已删除的月份（阶段 8 决定 12）：话单页的提示条。
 * 范围按北京日，所以取 [from 所在月, to 所在月]；旧标志没有元数据时 count、deletedBy、deletedAt 为 null。
 */
async function deletedMonthsIn(
  tx: Tx,
  tenantId: string,
  range: { from: string; to: string },
) {
  const { rows } = await tx.execute<{
    month: string;
    count: number | null;
    deleted_at: string | null;
    admin_id: string | null;
    admin_name: string | null;
  }>(sql`
    select to_char(s.month, 'YYYY-MM') as month, s.details_deleted_count as count,
      ${cdrTimestamp(sql`s.details_deleted_at`)} as deleted_at, a.id as admin_id, a.name as admin_name
    from monthly_statements s
    left join admins a on a.id = s.details_deleted_by
    where s.tenant_id = ${tenantId}::uuid and s.details_deleted
      and s.month >= date_trunc('month', ${range.from}::date)::date
      and s.month <= date_trunc('month', ${range.to}::date)::date
    order by s.month`);
  return rows.map((row) => ({
    month: row.month,
    count: row.count,
    deletedBy:
      row.admin_id !== null && row.admin_name !== null
        ? { id: row.admin_id, name: row.admin_name }
        : null,
    deletedAt: row.deleted_at,
  }));
}

export function listAdminCdrCountries(input: {
  db: Db;
  tenantId: string;
  from: string;
  to: string;
}) {
  return listCountries(input);
}

export function adminCdrExportCursorQuery({
  tenantId,
  query,
}: {
  tenantId: string;
  query: AdminCdrFilter;
}) {
  const time =
    query.status === 'all'
      ? sql`coalesce(c.answered_at, c.started_at)`
      : sql`c.answered_at`;
  const selection = sql`select c.call_uuid as "callUuid",
    to_char(${time} at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as "calledAt",
    to_char(c.started_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as "startedAt",
    case when c.answered_at is null then null else to_char(c.answered_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') end as "answeredAt",
    to_char(c.ended_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as "endedAt",
    c.caller as "caller", c.callee as "callee", c.country as "country", c.iso as "iso", c.description as "description",
    c.duration_seconds as "durationSeconds", c.billed_minutes::text as "billedMinutes",
    case when c.rate is null then null else round(c.rate, 4)::text end as "rate",
    c.charge::text as "charge", c.hangup_cause as "hangupCause",
    c.matched_prefix as "matchedPrefix", c.unverified as "unverified"
    from cdrs c where ${adminCdrFilters({ tenantId, query })}
    order by ${time} asc, c.call_uuid asc`;
  return new PgDialect().sqlToQuery(sql`with ${cdrBounds(query)} ${selection}`);
}

/** Count and write the acceptance audit in a short transaction before opening the cursor. */
export async function acceptAdminCdrExport({
  db,
  tenantId,
  actor,
  query,
  signal,
}: {
  db: PoolDb;
  tenantId: string;
  actor: AuditActor;
  query: AdminCdrExportRequest;
  signal: AbortSignal;
}) {
  const input = adminCdrExportRequestSchema.parse(query);
  if (signal.aborted) throw abortError(signal);
  return withBoundedExportClient(
    {
      pool: { connect: () => db.$client.connect() },
      signal,
      cancelBackend: (pid) => cancelPostgresBackend(db.$client, pid),
    },
    async (client) => {
      const auditDb = drizzle(client, { schema });
      return await auditDb.transaction(async (tx) => {
        ensureActive(signal);
        await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
        ensureActive(signal);
        await tx.execute(sql`set local statement_timeout = '30s'`);
        ensureActive(signal);
        await tx.execute(
          sql`set local idle_in_transaction_session_timeout = '30s'`,
        );
        ensureActive(signal);
        const tenant = await tx.execute<{ code: string }>(
          sql`select code from tenants where id = ${tenantId}::uuid`,
        );
        ensureActive(signal);
        const code = tenant.rows[0]?.code;
        if (!code) throw new NotFoundError('租户不存在');
        const { rows } = await tx.execute<{ total: number }>(sql`
        with ${cdrBounds(input)}
        select count(*)::int as total from cdrs c
        where ${adminCdrFilters({ tenantId, query: input })}
      `);
        ensureActive(signal);
        const rowCount = rows[0]?.total ?? 0;
        const event: AuditPayload = {
          id: randomUUID(),
          actor,
          occurredAt: new Date().toISOString(),
          tenantId,
          target: { kind: 'tenant', id: tenantId },
          action: 'cdr_export',
          content: {
            summary: `导出话单，共 ${rowCount} 条`,
            changes: [],
            rowCount,
            filters: {
              from: input.from,
              to: input.to,
              status: input.status,
              ...(input.callee ? { callee: input.callee } : {}),
              ...(input.country ? { country: input.country } : {}),
              unverifiedOnly: input.unverifiedOnly,
            },
          },
        };
        await writeAudit(tx, event);
        ensureActive(signal);
        return { code, rowCount };
      });
    },
  );
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('CDR export acceptance was interrupted');
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}
