import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const DATABASES = ['fs_billing_perf', 'fs_billing_perf_pr3_uuid_v4'] as const;
const TENANT_IDS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
] as const;
const IDS_SQL = `array[${TENANT_IDS.map((id) => `'${id}'::uuid`).join(',')}]`;
const BATCH_SIZE = 5_000;
const OUTPUT_PATH = resolve(
  import.meta.dirname,
  '../../../docs/evidence/phase-6/ledger-diagnostic-20261019T093425Z.json',
);

type EventGroup = {
  tenant_id: string;
  occurred_day_utc: string;
  occurred_at_utc: string;
  kind: string;
  amount_text: string;
  amount_scale: string;
  amount_trimmed: string;
  note: string;
  auth_user_id: string | null;
  multiplicity: string;
  created_by_profile_ids: string[] | null;
};

type Side = {
  database: string;
  client: pg.Client;
  cursor: string;
  batch: EventGroup[];
  offset: number;
  exhausted: boolean;
  eventRows: number;
  eventGroups: number;
};

function databaseUrl(database: string) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(['/fs_billing', '/fs_billing_perf'].includes(url.pathname));
  url.pathname = `/${database}`;
  return url.toString();
}

function compareCText(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function eventKey(row: EventGroup): string[] {
  return [
    row.tenant_id,
    row.occurred_day_utc,
    row.occurred_at_utc,
    row.kind,
    row.amount_text,
    row.amount_scale,
    row.amount_trimmed,
    row.note,
    row.auth_user_id ?? '',
  ];
}

function compareKey(left: EventGroup, right: EventGroup): number {
  const leftKey = eventKey(left);
  const rightKey = eventKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    const compared = compareCText(leftKey[index]!, rightKey[index]!);
    if (compared !== 0) return compared;
  }
  return 0;
}

async function openSide(database: string): Promise<Side> {
  const client = new pg.Client({
    connectionString: databaseUrl(database),
    application_name: `phase6_ledger_diff_${database}`,
    connectionTimeoutMillis: 2_000,
  });
  await client.connect();
  const identity = await client.query<{ database: string; role: string }>(
    'select current_database() as database,current_user as role',
  );
  assert.equal(identity.rows[0]?.database, database);
  assert.equal(identity.rows[0]?.role, 'fs_billing');
  await client.query('begin isolation level read committed read only');
  await client.query("set local statement_timeout='30min'");
  await client.query(
    `declare ledger_diff_cursor no scroll cursor for
     select l.tenant_id::text as tenant_id,
       to_char(l.occurred_at at time zone 'UTC','YYYY-MM-DD') as occurred_day_utc,
       to_char(l.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_utc,
       l.kind::text as kind,l.amount::text as amount_text,scale(l.amount)::text as amount_scale,
       trim_scale(l.amount)::text as amount_trimmed,l.note collate "C" as note,
       u.id as auth_user_id,count(*)::text as multiplicity,
       array_agg(distinct l.created_by::text) filter(where l.created_by is not null) as created_by_profile_ids
     from public.ledger_entries l
     left join public.admins a on a.id=l.created_by
     left join auth."user" u on u.id=a.auth_user_id
     where l.tenant_id=any(${IDS_SQL})
     group by l.tenant_id,l.occurred_at,l.kind,l.amount::text,scale(l.amount),
       trim_scale(l.amount)::text,l.note collate "C",u.id
     order by l.tenant_id,
       to_char(l.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') collate "C",
       l.kind collate "C",l.amount::text collate "C",scale(l.amount)::text collate "C",
       trim_scale(l.amount)::text collate "C",l.note collate "C",coalesce(u.id,'') collate "C"`,
  );
  return {
    database,
    client,
    cursor: 'ledger_diff_cursor',
    batch: [],
    offset: 0,
    exhausted: false,
    eventRows: 0,
    eventGroups: 0,
  };
}

async function nextEvent(side: Side): Promise<EventGroup | null> {
  if (side.offset >= side.batch.length && !side.exhausted) {
    const result = await side.client.query<EventGroup>(
      `fetch forward ${BATCH_SIZE} from ${side.cursor}`,
    );
    side.batch = result.rows;
    side.offset = 0;
    if (result.rows.length === 0) side.exhausted = true;
  }
  const row = side.batch[side.offset];
  if (!row) return null;
  side.offset += 1;
  side.eventGroups += 1;
  side.eventRows += Number(row.multiplicity);
  return row;
}

async function actorSummary(side: Side) {
  const result = await side.client.query<Record<string, string | null>>(
    `select l.tenant_id::text,l.kind,u.id as auth_user_id,u.email,a.name,
       count(*)::text as rows,sum(l.amount)::text as amount,
       to_char(min(l.occurred_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as first_occurred,
       to_char(max(l.occurred_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_occurred
     from public.ledger_entries l
     left join public.admins a on a.id=l.created_by
     left join auth."user" u on u.id=a.auth_user_id
     where l.tenant_id=any(${IDS_SQL}) and l.kind<>'call_charge'
     group by l.tenant_id,l.kind,u.id,u.email,a.name
     order by l.tenant_id,l.kind,u.id`,
  );
  return result.rows;
}

async function actorCounterpart(side: Side, event: EventGroup | null) {
  if (!event) return [];
  const result = await side.client.query<Record<string, string | null>>(
    `select l.tenant_id::text,
       to_char(l.occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at_utc,
       l.kind,l.amount::text as amount_text,scale(l.amount)::text as amount_scale,
       trim_scale(l.amount)::text as amount_trimmed,l.note collate "C" as note,
       l.created_by::text as profile_id,u.id as auth_user_id,u.email,a.name,
       count(*)::text as multiplicity
     from public.ledger_entries l
     left join public.admins a on a.id=l.created_by
     left join auth."user" u on u.id=a.auth_user_id
     where l.tenant_id=$1::uuid and l.occurred_at=$2::timestamptz
       and l.kind=$3 and l.amount::text=$4 and scale(l.amount)::text=$5
       and trim_scale(l.amount)::text=$6 and l.note=$7
     group by l.tenant_id,l.occurred_at,l.kind,l.amount::text,scale(l.amount),
       trim_scale(l.amount)::text,l.note collate "C",l.created_by,u.id,u.email,a.name
     order by l.created_by`,
    [
      event.tenant_id,
      event.occurred_at_utc,
      event.kind,
      event.amount_text,
      event.amount_scale,
      event.amount_trimmed,
      event.note,
    ],
  );
  return result.rows;
}

function safeEvent(row: EventGroup | null) {
  return row
    ? {
        ...row,
        multiplicity: Number(row.multiplicity),
      }
    : null;
}

async function main() {
  const startedAt = new Date().toISOString();
  const [oldSide, newSide] = await Promise.all([
    openSide(DATABASES[0]),
    openSide(DATABASES[1]),
  ]);
  let oldRow = await nextEvent(oldSide);
  let newRow = await nextEvent(newSide);
  const differences: Array<Record<string, unknown>> = [];
  let comparedGroups = 0;
  while (oldRow !== null || newRow !== null) {
    if (oldRow === null) {
      differences.push({
        type: 'missing-in-old',
        old: null,
        new: safeEvent(newRow),
      });
      newRow = await nextEvent(newSide);
    } else if (newRow === null) {
      differences.push({
        type: 'missing-in-new',
        old: safeEvent(oldRow),
        new: null,
      });
      oldRow = await nextEvent(oldSide);
    } else {
      const compared = compareKey(oldRow, newRow);
      if (compared === 0) {
        comparedGroups += 1;
        if (oldRow.multiplicity !== newRow.multiplicity) {
          differences.push({
            type: 'multiplicity-diff',
            old: safeEvent(oldRow),
            new: safeEvent(newRow),
          });
        }
        oldRow = await nextEvent(oldSide);
        newRow = await nextEvent(newSide);
      } else if (compared < 0) {
        differences.push({
          type: 'missing-in-new',
          old: safeEvent(oldRow),
          new: null,
        });
        oldRow = await nextEvent(oldSide);
      } else {
        differences.push({
          type: 'missing-in-old',
          old: null,
          new: safeEvent(newRow),
        });
        newRow = await nextEvent(newSide);
      }
    }
    if (differences.length > 0) break;
    if (comparedGroups > 0 && comparedGroups % 100_000 === 0) {
      process.stderr.write(
        `${JSON.stringify({
          event: 'ledger-groups-compared',
          comparedGroups,
          oldEventRows: oldSide.eventRows,
          newEventRows: newSide.eventRows,
        })}\n`,
      );
    }
  }
  const oldActors = await oldSide.client.query(
    `select u.id as auth_user_id,u.email,a.name
     from public.admins a join auth."user" u on u.id=a.auth_user_id order by u.id`,
  );
  const newActors = await newSide.client.query(
    `select u.id as auth_user_id,u.email,a.name
     from public.admins a join auth."user" u on u.id=a.auth_user_id order by u.id`,
  );
  const firstDifference = differences[0];
  const anchor =
    (firstDifference?.new as EventGroup | null | undefined) ??
    (firstDifference?.old as EventGroup | null | undefined) ??
    null;
  const actorCounterparts = anchor
    ? {
        event: safeEvent(anchor),
        old: await actorCounterpart(oldSide, anchor),
        new: await actorCounterpart(newSide, anchor),
      }
    : null;
  const evidence = {
    readOnly: true,
    startedAt,
    completedAt: new Date().toISOString(),
    comparison:
      'ordered dual-cursor merge of exact grouped ledger events by tenant, UTC day and occurred_at (six fractional digits), kind, original amount::text, scale(amount), trim_scale(amount)::text, note and normalized auth_user_id; multiplicity and source/target admin profile IDs retained',
    oldDatabase: oldSide.database,
    newDatabase: newSide.database,
    comparedGroups,
    oldEventRows: oldSide.eventRows,
    newEventRows: newSide.eventRows,
    groupRowsConsumed: {
      old: oldSide.eventGroups,
      new: newSide.eventGroups,
    },
    oldActorIdentities: oldActors.rows,
    newActorIdentities: newActors.rows,
    manualLedgerActorSummary: {
      old: await actorSummary(oldSide),
      new: await actorSummary(newSide),
    },
    firstDifferenceActorCounterparts: actorCounterparts,
    firstDifferences: differences,
    equal: differences.length === 0 && oldSide.eventRows === newSide.eventRows,
  };
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, `${JSON.stringify(evidence, null, 2)}\n`, {
    flag: 'wx',
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  for (const side of [oldSide, newSide]) {
    await side.client.query(`close ${side.cursor}`).catch(() => undefined);
    await side.client.query('rollback').catch(() => undefined);
    await side.client.end();
  }
  assert.equal(
    differences.length,
    0,
    'ledger event multiset differs; inspect the first stored difference',
  );
  assert.equal(oldSide.eventRows, newSide.eventRows);
}

await main();
