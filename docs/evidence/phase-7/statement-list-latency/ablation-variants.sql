-- Variants used for the hot/cold timing tables. Run with psql against a COPY of the perf database, as role fs_billing_app inside a transaction:
--   begin; set local role fs_billing_app; select set_config('app.scope','tenant',true), set_config('app.tenant_id', :'tid', true) \gset; set local jit = off;
--   \set tid '00000000-0000-4000-8000-000000000001'  \set month '2026-10-01'  \set asof '2026-10-22 23:24:13+00'
-- The literal-bound variants hard-code lo = '2026-09-30 16:00:00+00' (2026-10-01 00:00 Beijing) and hi = '2026-10-22 23:24:13+00'.

-- ===== base: current statement from compute.ts (balance opening), `bounds` CTE, opening referenced twice
with bounds as (
      select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
    ),
    opening as (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = :'tid'::uuid and occurred_at >= (select lo from bounds)) as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = :'tid'::uuid
        and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by c.country
    ),
    by_day as (
      select (c.answered_at at time zone 'Asia/Shanghai')::date as day,
        count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by 1
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'day', day::text, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by day), '[]'::jsonb) from by_day) as days
    from opening o cross join flows f;

-- ===== a1_nodays: base without the by_day CTE and the days column (dead work for the list)
with bounds as (
      select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
    ),
    opening as (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = :'tid'::uuid and occurred_at >= (select lo from bounds)) as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = :'tid'::uuid
        and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by c.country
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      '[]'::jsonb as days
    from opening o cross join flows f;

-- ===== a5_lmb_dup: list-only figures (totals instead of per-country, no days), still `bounds` CTE, opening inlined twice
with bounds as (
  select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
),
opening as (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
      - (select coalesce(sum(amount), 0) from ledger_entries
         where tenant_id = :'tid'::uuid and occurred_at >= (select lo from bounds)) as amount),
flows as (
  select
    coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
    coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
    coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
    coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
  from ledger_entries
  where tenant_id = :'tid'::uuid
    and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
),
totals as (
  select count(*)::int as calls, coalesce(sum(c.billed_minutes), 0) as minutes
  from cdrs c
  where c.tenant_id = :'tid'::uuid
    and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
    and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
)
select o.amount::text, f.recharge::text, f.gift::text, f.adjustment::text, f.call_charges::text,
  (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text, t.calls, t.minutes::text
from opening o cross join flows f cross join totals t;

-- ===== bmat: base with `opening as materialized` (anchor evaluated once, planner still blind to the bounds)
with bounds as (
      select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
    ),
    opening as materialized (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = :'tid'::uuid and occurred_at >= (select lo from bounds)) as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = :'tid'::uuid
        and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by c.country
    ),
    by_day as (
      select (c.answered_at at time zone 'Asia/Shanghai')::date as day,
        count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by 1
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'day', day::text, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by day), '[]'::jsonb) from by_day) as days
    from opening o cross join flows f;

-- ===== lit: base with literal bounds (planner sees the values), opening still evaluated twice
with bounds as (
      select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
    ),
    opening as (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = :'tid'::uuid and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz) as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = :'tid'::uuid
        and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz and occurred_at < '2026-10-22 23:24:13+00'::timestamptz
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
        and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
      group by c.country
    ),
    by_day as (
      select (c.answered_at at time zone 'Asia/Shanghai')::date as day,
        count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
        and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
      group by 1
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'day', day::text, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by day), '[]'::jsonb) from by_day) as days
    from opening o cross join flows f;

-- ===== litmat: base with literal bounds and `opening as materialized` (what V1 in the node prototype does with bind parameters)
with bounds as (
      select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
    ),
    opening as materialized (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = :'tid'::uuid and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz) as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = :'tid'::uuid
        and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz and occurred_at < '2026-10-22 23:24:13+00'::timestamptz
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
        and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
      group by c.country
    ),
    by_day as (
      select (c.answered_at at time zone 'Asia/Shanghai')::date as day,
        count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = :'tid'::uuid
        and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
        and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
      group by 1
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'day', day::text, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by day), '[]'::jsonb) from by_day) as days
    from opening o cross join flows f;

-- ===== lmb: list-only figures, `bounds` CTE kept, opening materialized
with bounds as (
  select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
),
opening as materialized (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
      - (select coalesce(sum(amount), 0) from ledger_entries
         where tenant_id = :'tid'::uuid and occurred_at >= (select lo from bounds)) as amount),
flows as (
  select
    coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
    coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
    coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
    coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
  from ledger_entries
  where tenant_id = :'tid'::uuid
    and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
),
totals as (
  select count(*)::int as calls, coalesce(sum(c.billed_minutes), 0) as minutes
  from cdrs c
  where c.tenant_id = :'tid'::uuid
    and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
    and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
)
select o.amount::text, f.recharge::text, f.gift::text, f.adjustment::text, f.call_charges::text,
  (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text, t.calls, t.minutes::text
from opening o cross join flows f cross join totals t;

-- ===== lml: list-only figures, literal bounds
with bounds as (
  select (:'month'::date)::timestamp at time zone 'Asia/Shanghai' as lo, least(((:'month'::date + interval '1 month'))::timestamp at time zone 'Asia/Shanghai', :'asof'::timestamptz) as hi
),
opening as materialized (select (select balance from tenant_balances where tenant_id = :'tid'::uuid)
      - (select coalesce(sum(amount), 0) from ledger_entries
         where tenant_id = :'tid'::uuid and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz) as amount),
flows as (
  select
    coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
    coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
    coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
    coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
  from ledger_entries
  where tenant_id = :'tid'::uuid
    and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz and occurred_at < '2026-10-22 23:24:13+00'::timestamptz
),
totals as (
  select count(*)::int as calls, coalesce(sum(c.billed_minutes), 0) as minutes
  from cdrs c
  where c.tenant_id = :'tid'::uuid
    and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
    and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
)
select o.amount::text, f.recharge::text, f.gift::text, f.adjustment::text, f.call_charges::text,
  (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text, t.calls, t.minutes::text
from opening o cross join flows f cross join totals t;

-- ===== lml1: list-only figures, literal bounds, one ledger scan for anchor and flows (V2 in the node prototype)
with ledger as (
  select
    coalesce(sum(amount), 0) as tail_total,
    coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge') and occurred_at < '2026-10-22 23:24:13+00'::timestamptz), 0) as recharge,
    coalesce(sum(amount) filter (where kind = 'gift' and occurred_at < '2026-10-22 23:24:13+00'::timestamptz), 0) as gift,
    coalesce(sum(amount) filter (where kind = 'adjustment' and occurred_at < '2026-10-22 23:24:13+00'::timestamptz), 0) as adjustment,
    coalesce(-sum(amount) filter (where kind = 'call_charge' and occurred_at < '2026-10-22 23:24:13+00'::timestamptz), 0) as call_charges
  from ledger_entries
  where tenant_id = :'tid'::uuid and occurred_at >= '2026-09-30 16:00:00+00'::timestamptz
),
totals as (
  select count(*)::int as calls, coalesce(sum(c.billed_minutes), 0) as minutes
  from cdrs c
  where c.tenant_id = :'tid'::uuid
    and c.answered_at >= '2026-09-30 16:00:00+00'::timestamptz and c.answered_at < '2026-10-22 23:24:13+00'::timestamptz
    and c.started_at >= ('2026-09-30 16:00:00+00'::timestamptz - interval '31 days') and c.started_at < '2026-10-22 23:24:13+00'::timestamptz
)
select ((select balance from tenant_balances where tenant_id = :'tid'::uuid) - l.tail_total)::text as opening, l.recharge::text, l.gift::text, l.adjustment::text, l.call_charges::text,
  ((select balance from tenant_balances where tenant_id = :'tid'::uuid) - l.tail_total + l.recharge + l.gift + l.adjustment - l.call_charges)::text as closing, t.calls, t.minutes::text
from ledger l cross join totals t;
