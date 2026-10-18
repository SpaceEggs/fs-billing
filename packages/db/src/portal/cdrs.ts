import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  CDR_PAGE_SIZE,
  cdrCountriesResponseSchema,
  portalCdrCountriesQuerySchema,
  portalCdrsQuerySchema,
  portalCdrsResponseSchema,
  type PortalCdrsQuery,
} from '@fs-billing/shared';
import { withTenant, type Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { cdrBounds, cdrFilters, cdrTimestamp } from '../cdr-query.js';
import type { PortalCdrFilter } from '../cdr-query.js';

export function portalCdrProjection(alias: 'c' | 'p') {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  return sql`jsonb_build_object(
    'callUuid', ${column('call_uuid')},
    'startedAt', ${cdrTimestamp(column('started_at'))},
    'answeredAt', case when ${column('answered_at')} is null then null else ${cdrTimestamp(column('answered_at'))} end,
    'endedAt', ${cdrTimestamp(column('ended_at'))},
    'caller', ${column('caller')},
    'callee', ${column('callee')},
    'country', ${column('country')},
    'matchedPrefix', ${column('matched_prefix')},
    'durationSeconds', ${column('duration_seconds')},
    'billedMinutes', ${column('billed_minutes')}::text,
    'rate', ${column('rate')}::text,
    'charge', ${column('charge')}::text,
    'hangupCause', ${column('hangup_cause')}
  )`;
}

export async function queryCdrs({
  db,
  tenantId,
  query,
}: {
  db: Db;
  tenantId: string;
  query: PortalCdrsQuery;
}) {
  const input = portalCdrsQuerySchema.parse(query);
  const filters = cdrFilters({ tenantId, query: input });
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.execute<{ response: unknown }>(sql`
      with ${cdrBounds(input)},
      filtered as (
        select c.call_uuid, c.started_at, c.answered_at, c.ended_at,
          c.caller, c.callee, c.country, c.matched_prefix, c.duration_seconds,
          c.billed_minutes, c.rate, c.charge, c.hangup_cause
        from cdrs c where ${filters}
      ),
      stats as (
        select count(*)::int as total,
          coalesce(sum(billed_minutes), 0)::text as billed_minutes,
          coalesce(sum(charge), 0)::text as charge,
          count(*) filter (where answered_at is null)::int as unanswered
        from filtered
      ),
      hidden_unanswered as (
        select count(*)::int as total from cdrs c
        where ${
          input.status === 'answered' && !input.country
            ? sql`c.tenant_id = ${tenantId}::uuid
              and c.answered_at is null
              and c.started_at >= (select lo from bounds)
              and c.started_at < (select hi from bounds)
              and c.started_at >= (select lo from bounds) - interval '31 days'
              and c.started_at < (select hi from bounds)
              ${input.callee ? sql`and c.billing_number like ${`%${input.callee}%`}` : sql``}`
            : sql`false`
        }
      ),
      page as (
        select c.call_uuid, c.started_at, c.answered_at, c.ended_at,
          c.caller, c.callee, c.country, c.matched_prefix, c.duration_seconds,
          c.billed_minutes, c.rate, c.charge, c.hangup_cause
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
        'items', coalesce((select jsonb_agg(${portalCdrProjection('p')} order by ${
          input.status === 'all'
            ? sql`coalesce(p.answered_at, p.started_at)`
            : sql`p.answered_at`
        } desc, p.call_uuid desc) from page p), '[]'::jsonb),
        'pagination', jsonb_build_object('page', ${input.page}::int,
          'pageSize', ${CDR_PAGE_SIZE}::int, 'total', stats.total),
        'summary', jsonb_build_object('billedMinutes', stats.billed_minutes,
          'charge', stats.charge,
          'unansweredCalls', case when ${input.status} = 'all' then stats.unanswered else hidden_unanswered.total end)
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
    return response;
  });
}

export function listPortalCdrs(input: {
  db: Db;
  tenantId: string;
  query: PortalCdrsQuery;
}) {
  return queryCdrs(input).then((response) =>
    portalCdrsResponseSchema.parse(response),
  );
}

export async function listCountries({
  db,
  tenantId,
  from,
  to,
}: {
  db: Db;
  tenantId: string;
  from: string;
  to: string;
}) {
  const input = portalCdrCountriesQuerySchema.parse({ from, to });
  return withTenant(db, tenantId, async (tx) => {
    const { rows } = await tx.execute<{ response: unknown }>(sql`
      with bounds as (
        select (${input.from}::date)::timestamp at time zone 'Asia/Shanghai' as lo,
          ((${input.to}::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
      )
      select jsonb_build_object('countries', coalesce(jsonb_agg(country order by n desc, country), '[]'::jsonb)) as response
      from (
        select c.country, count(*) as n from cdrs c
        where c.tenant_id = ${tenantId}::uuid and c.answered_at >= (select lo from bounds)
          and c.answered_at < (select hi from bounds)
          and c.started_at >= (select lo from bounds) - interval '31 days'
          and c.started_at < (select hi from bounds) and c.country is not null
        group by c.country
      ) options
    `);
    const tenant = await tx.execute<{ exists: boolean }>(
      sql`select exists(select 1 from tenants where id = ${tenantId}::uuid) as exists`,
    );
    if (!tenant.rows[0]?.exists) throw new NotFoundError('租户不存在');
    return cdrCountriesResponseSchema.parse(rows[0]?.response);
  });
}

export function listPortalCdrCountries(input: {
  db: Db;
  tenantId: string;
  from: string;
  to: string;
}) {
  return listCountries(input);
}

export function portalCdrExportCursorQuery({
  tenantId,
  query,
}: {
  tenantId: string;
  query: PortalCdrFilter;
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
    c.caller as "caller", c.callee as "callee", c.country as "country",
    c.duration_seconds as "durationSeconds", c.billed_minutes::text as "billedMinutes",
    case when c.rate is null then null else round(c.rate, 4)::text end as "rate",
    c.charge::text as "charge", c.hangup_cause as "hangupCause",
    c.matched_prefix as "matchedPrefix"
    from cdrs c where ${cdrFilters({ tenantId, query })}
    order by ${time} asc, c.call_uuid asc`;
  return new PgDialect().sqlToQuery(sql`with ${cdrBounds(query)} ${selection}`);
}
