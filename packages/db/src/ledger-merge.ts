import { sql, type SQL } from 'drizzle-orm';
import {
  PORTAL_CREDIT_RECHARGE_NOTE,
  type PortalLedgerExportRequest,
  type AdminLedgerQuery,
  type PortalLedgerQuery,
} from '@fs-billing/shared';
import { PgDialect } from 'drizzle-orm/pg-core';

export type LedgerAnchor = 'prior' | 'balance';
type LedgerQueryInput = {
  tenantId: string;
  query: AdminLedgerQuery | PortalLedgerQuery;
  pageSize: number;
  audience: 'admin' | 'portal';
  /** Explicit anchors support equivalence tests and the reproducible perf probe. */
  anchor?: LedgerAnchor;
};

/** Shared ordering, balances and filtering; internal fields never enter the portal select. */
export function mergedLedgerSql({
  tenantId,
  query,
  pageSize,
  audience,
  anchor,
}: LedgerQueryInput): SQL {
  const prior = sql`(select coalesce(sum(amount), 0) from ledger_entries
    where tenant_id = ${tenantId}::uuid and occurred_at < (select lo from bounds))`;
  const balance = sql`t.balance - (select coalesce(sum(amount), 0) from ledger_entries
    where tenant_id = ${tenantId}::uuid and occurred_at >= (select lo from bounds))`;
  const anchorAmount =
    anchor === 'prior'
      ? prior
      : anchor === 'balance'
        ? balance
        : sql`case when (select lo from bounds) - t.created_at <=
            statement_timestamp() - (select lo from bounds)
          then ${prior} else ${balance} end`;
  const filter = query.kind
    ? audience === 'portal' && query.kind === 'recharge'
      ? sql`kind in ('recharge', 'credit_recharge')`
      : sql`kind = ${query.kind}`
    : sql`true`;
  const manual =
    audience === 'portal'
      ? sql`jsonb_build_object(
          'id', p.id, 'kind', case when p.kind = 'credit_recharge' then 'recharge' else p.kind end,
          'note', p.note)`
      : sql`jsonb_build_object(
          'id', p.id, 'kind', p.kind, 'note', p.note,
          'noteVisibility', case when p.kind = 'credit_recharge' then 'admin' else 'customer' end,
          'paymentStatus', r.status,
          'actor', jsonb_build_object('id', a.id, 'name', a.name))`;
  const note =
    audience === 'portal'
      ? sql`case when kind = 'credit_recharge' then ${PORTAL_CREDIT_RECHARGE_NOTE} else note end`
      : sql`note`;
  const joins =
    audience === 'admin'
      ? sql`left join ledger_entries source on source.id = p.id and source.tenant_id = ${tenantId}::uuid
          left join receivables r on r.ledger_entry_id = p.id and r.tenant_id = ${tenantId}::uuid
          left join admins a on a.id = source.created_by`
      : sql``;
  // An id identifies one manual row; a null id identifies only the charge group for that day.
  // Group on date first to avoid comparing kind text while sorting every charge.
  return sql`
    with bounds as (
      select (${query.from}::date)::timestamp at time zone 'Asia/Shanghai' as lo,
        ((${query.to}::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
    ),
    tenant as (
      select t.currency, t.created_at, b.balance
      from tenants t join tenant_balances b on b.tenant_id = t.id
      where t.id = ${tenantId}::uuid
    ),
    anchor as (select ${anchorAmount} as amount from tenant t),
    merged as (
      select case when kind = 'call_charge' then null else id end as id,
        (array_agg(id order by occurred_at desc, id desc))[1] as sort_id,
        max(kind) as kind, (occurred_at at time zone 'Asia/Shanghai')::date as day,
        max(occurred_at) as at, count(*)::int as calls,
        sum(amount) as amount, max(${note}) as note
      from ledger_entries
      where tenant_id = ${tenantId}::uuid
        and occurred_at >= (select lo from bounds)
        and occurred_at < (select hi from bounds)
      group by 4, 1
    ),
    windowed as (
      select m.*, a.amount + sum(m.amount) over (order by at, sort_id) as balance_after
      from merged m cross join anchor a
    ),
    filtered as (select * from windowed where ${filter}),
    stats as (select count(*)::int as total, coalesce(sum(amount), 0) as total_amount from filtered),
    page as (select * from filtered order by at desc, sort_id desc
      limit ${pageSize} offset ${(query.page - 1) * pageSize}),
    projected as (
      select p.at, p.sort_id,
        jsonb_build_object('amount', p.amount::text, 'balanceAfter', p.balance_after::text,
          'occurredAt', to_char(p.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ||
        case when p.kind = 'call_charge' then jsonb_build_object(
          'kind', 'call_charge', 'day', p.day::text, 'calls', p.calls,
          'partial', p.day = (statement_timestamp() at time zone 'Asia/Shanghai')::date)
        else ${manual} end as item
      from page p ${joins}
    )
    select jsonb_build_object(
      'currency', t.currency, 'balance', t.balance::text,
      'totalAmount', s.total_amount::text,
      'pagination', jsonb_build_object('page', ${query.page}::int, 'pageSize', ${pageSize}::int, 'total', s.total),
      'items', coalesce((select jsonb_agg(item order by at desc, sort_id desc) from projected), '[]'::jsonb)
    ) as ledger
    from tenant t cross join stats s
  `;
}

/** Row-shaped portal projection used by the streaming CSV cursor. */
export function mergedLedgerExportQuery({
  tenantId,
  query,
}: {
  tenantId: string;
  query: PortalLedgerExportRequest;
}) {
  const filter = query.kind
    ? query.kind === 'recharge'
      ? sql`kind in ('recharge', 'credit_recharge')`
      : sql`kind = ${query.kind}`
    : sql`true`;
  const prior = sql`(select coalesce(sum(amount), 0) from ledger_entries
    where tenant_id = ${tenantId}::uuid and occurred_at < bounds.lo)`;
  const balance = sql`t.balance - (select coalesce(sum(amount), 0) from ledger_entries
    where tenant_id = ${tenantId}::uuid and occurred_at >= bounds.lo)`;
  const anchorAmount = sql`case when bounds.lo - t.created_at <=
    statement_timestamp() - bounds.lo then ${prior} else ${balance} end`;
  const visibleNote = sql`case when kind = 'credit_recharge' then ${PORTAL_CREDIT_RECHARGE_NOTE} else note end`;
  const statement = sql`
    with bounds as (
      select (${query.from}::date)::timestamp at time zone 'Asia/Shanghai' as lo,
        ((${query.to}::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
    ), tenant as (
      select t.created_at, b.balance from tenants t
      join tenant_balances b on b.tenant_id = t.id where t.id = ${tenantId}::uuid
    ), anchor as (select ${anchorAmount} as amount from tenant t cross join bounds),
    merged as (
      select case when kind = 'call_charge' then null else id end as id,
        (array_agg(id order by occurred_at desc, id desc))[1] as sort_id,
        max(kind) as kind, (occurred_at at time zone 'Asia/Shanghai')::date as day,
        max(occurred_at) as at, count(*)::int as calls, sum(amount) as amount,
        max(${visibleNote}) as note
      from ledger_entries where tenant_id = ${tenantId}::uuid
        and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
      group by 4, 1
    ), windowed as (
      select m.*, a.amount + sum(m.amount) over (order by at, sort_id) as balance_after
      from merged m cross join anchor a
    ), filtered as (select * from windowed where ${filter})
    select case when kind = 'credit_recharge' then 'recharge' else kind end as kind,
      day::text as day, calls,
      to_char(at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as "occurredAt",
      amount::text as amount, balance_after::text as "balanceAfter", note,
      (day = (statement_timestamp() at time zone 'Asia/Shanghai')::date) as partial
    from filtered order by at desc, sort_id desc
  `;
  return new PgDialect().sqlToQuery(statement);
}
