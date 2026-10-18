import { sql, type SQL } from 'drizzle-orm';
import type {
  AdminCdrExportRequest,
  AdminCdrsQuery,
  PortalCdrExportRequest,
  PortalCdrsQuery,
} from '@fs-billing/shared';

export type PortalCdrFilter =
  Omit<PortalCdrsQuery, 'page'> | PortalCdrExportRequest;
export type AdminCdrFilter =
  Omit<AdminCdrsQuery, 'page'> | AdminCdrExportRequest;
type DayRange = Pick<PortalCdrExportRequest, 'from' | 'to'>;

/** Shared CDR predicates keep list, summaries, exports and country options aligned. */
export function cdrBounds(query: DayRange) {
  return sql`bounds as (
    select (${query.from}::date)::timestamp at time zone 'Asia/Shanghai' as lo,
      ((${query.to}::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
  )`;
}

export function cdrFilters({
  tenantId,
  query,
}: {
  tenantId: string;
  query: PortalCdrFilter;
}): SQL {
  const answeredRange =
    query.status === 'all'
      ? sql`coalesce(c.answered_at, c.started_at)`
      : sql`c.answered_at`;
  const filters: SQL[] = [
    sql`c.tenant_id = ${tenantId}::uuid`,
    sql`${answeredRange} >= (select lo from bounds)`,
    sql`${answeredRange} < (select hi from bounds)`,
    sql`c.started_at >= (select lo from bounds) - interval '31 days'`,
    sql`c.started_at < (select hi from bounds)`,
  ];
  if (query.callee)
    filters.push(sql`c.billing_number like ${`%${query.callee}%`}`);
  if (query.country) filters.push(sql`c.country = ${query.country}`);
  return sql.join(filters, sql` and `);
}

export function adminCdrFilters({
  tenantId,
  query,
}: {
  tenantId: string;
  query: AdminCdrFilter;
}): SQL {
  const filters: SQL[] = [cdrFilters({ tenantId, query })];
  if ('unverifiedOnly' in query && query.unverifiedOnly)
    filters.push(sql`c.unverified`);
  return sql.join(filters, sql` and `);
}

export function cdrTimestamp(column: SQL): SQL<string> {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
