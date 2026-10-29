import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { money } from '@fs-billing/rating';
import { connect, withAdmin, type Connection } from './client.js';
import { appendLedgerEntry } from './ledger.js';
import { seedDatabase } from './seed.js';

const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
const BACKFILL = 'fs_billing_balance_backfill';
const SEEDED = 'fs_billing_balance_seeded';
const EMPTY = 'fs_billing_balance_empty';

const urlFor = (database: string) => {
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${database}`;
  return url.toString();
};

let admin: Connection;
let folder: string;
const opened: Connection[] = [];

async function freshDatabase(name: string): Promise<Connection> {
  await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.pool.query(`CREATE DATABASE ${name}`);
  const connection = connect(urlFor(name));
  opened.push(connection);
  return connection;
}

beforeAll(async () => {
  admin = connect(inject('ownerUrl'));
  // 不含余额通知迁移（0023 / 合并后重排的编号，以 tag 后缀认）的迁移目录。
  folder = await mkdtemp(join(tmpdir(), 'fsb-balance-backfill-'));
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = JSON.parse(
    await readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  const at = journal.entries.findIndex((entry) =>
    entry.tag.endsWith('_balance_notices'),
  );
  expect(at).toBeGreaterThan(0);
  journal.entries = journal.entries.slice(0, at);
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify(journal),
  );
});

afterAll(async () => {
  for (const connection of opened) await connection.pool.end();
  for (const name of [BACKFILL, SEEDED, EMPTY])
    await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.pool.end();
  await rm(folder, { recursive: true, force: true });
});

interface Row {
  code: string;
  low_active: boolean;
  suspended_active: boolean;
  low_seq: number;
  suspended_seq: number;
}
const states = async (connection: Connection) =>
  new Map(
    (
      await connection.pool.query<Row>(
        `select t.code, n.low_active, n.suspended_active, n.low_seq, n.suspended_seq
         from tenants t join balance_notice_state n on n.tenant_id = t.id`,
      )
    ).rows.map((row) => [row.code, row]),
  );
const outboxCount = async (connection: Connection) =>
  (
    await connection.pool.query<{ n: number }>(
      'select count(*)::int as n from email_outbox',
    )
  ).rows[0]!.n;

describe('迁移 0023 的回填', () => {
  it('backfilled tenants queue no email', async () => {
    const scratch = await freshDatabase(BACKFILL);
    await migrate(scratch.db, { migrationsFolder: folder });
    // 迁移前的库结构：有发件箱，没有状态表。
    expect(
      (
        await scratch.pool.query(
          `select to_regclass('balance_notice_state') as t`,
        )
      ).rows,
    ).toEqual([{ t: null }]);
    await seedDatabase(scratch.db);
    // 另有一个没有提醒设置、已低于零的租户（手工插入的旧数据）。
    const bare = randomUUID();
    await scratch.pool.query(
      `insert into tenants (id, code, name, currency, overdraft_limit) values ($1, 'BARE0001', '无设置', 'CNY', 10)`,
      [bare],
    );
    await scratch.pool.query(
      `update tenant_balances set balance = -50 where tenant_id = $1`,
      [bare],
    );
    const tenantCount = (
      await scratch.pool.query<{ n: number }>(
        'select count(*)::int as n from tenants',
      )
    ).rows[0]!.n;
    expect(tenantCount).toBe(11);
    expect(await outboxCount(scratch)).toBe(0);

    await migrate(scratch.db, { migrationsFolder });

    // 没有补发：发件箱仍是空的；每个租户一行状态，标志取当前余额的真值，序号为 0。
    expect(await outboxCount(scratch)).toBe(0);
    const state = await states(scratch);
    expect(state.size).toBe(tenantCount);
    for (const row of state.values())
      expect(row).toMatchObject({ low_seq: 0, suspended_seq: 0 });
    // 已停机：HZX014（−100.36，透支 100）、GLB009（−15.02，透支 15）。
    expect(state.get('HZX014')).toMatchObject({
      low_active: true,
      suspended_active: true,
    });
    expect(state.get('GLB009')).toMatchObject({
      low_active: true,
      suspended_active: true,
    });
    // 透支中、余额不足但没停机：ABC001（−35.20）、GZT007（86.50，阈值 100）。
    expect(state.get('ABC001')).toMatchObject({
      low_active: true,
      suspended_active: false,
    });
    expect(state.get('GZT007')).toMatchObject({
      low_active: true,
      suspended_active: false,
    });
    // 没有提醒设置：阈值按 0 处理，不记低余额；可用额度 −40 记为已停机。
    expect(state.get('BARE0001')).toMatchObject({
      low_active: false,
      suspended_active: true,
    });
    // 与现有「状态」口径逐租户一致：低余额标志 = 阈值大于 0 且余额低于阈值，停机标志 = 可用额度不大于 0。
    const { rows: expected } = await scratch.pool.query<{
      code: string;
      low: boolean;
      suspended: boolean;
    }>(
      `select t.code,
              coalesce(s.threshold, 0) > 0 and b.balance < coalesce(s.threshold, 0) as low,
              b.balance + t.overdraft_limit <= 0 as suspended
       from tenants t
       join tenant_balances b on b.tenant_id = t.id
       left join balance_alert_settings s on s.tenant_id = t.id`,
    );
    for (const row of expected)
      expect(state.get(row.code)).toMatchObject({
        low_active: row.low,
        suspended_active: row.suspended,
      });

    // 升级之后：已在线下的租户继续变化不再通知（状态已是「已通知」）。
    const abc = (
      await scratch.pool.query<{ id: string }>(
        `select id from tenants where code = 'ABC001'`,
      )
    ).rows[0]!.id;
    await withAdmin(scratch.db, (tx) =>
      appendLedgerEntry(
        tx,
        { id: abc, currency: 'CNY' },
        {
          kind: 'call_charge',
          amount: money('CNY', '-1'),
          occurredAt: new Date('2026-10-29T01:00:00Z'),
          note: 'after upgrade',
          idempotencyKey: `after-upgrade:${abc}`,
        },
      ),
    );
    expect(await outboxCount(scratch)).toBe(0);
  });

  it('seeding a migrated database queues no balance notice and keeps the states', async () => {
    const seeded = await freshDatabase(SEEDED);
    await migrate(seeded.db, { migrationsFolder });
    await seedDatabase(seeded.db);
    // 播种期间触发器会为越线的种子租户排邮件；种子写的是历史，这些邮件被清掉。
    expect(await outboxCount(seeded)).toBe(0);
    const state = await states(seeded);
    expect(state.size).toBe(10);
    expect(state.get('HZX014')).toMatchObject({
      low_active: true,
      suspended_active: true,
    });
    expect(state.get('GZT007')).toMatchObject({
      low_active: true,
      suspended_active: false,
    });
    // 触发器确实在播种时跑过（序号走了），只是邮件被清掉了。
    expect(state.get('HZX014')!.suspended_seq).toBeGreaterThanOrEqual(1);
    // 再播一次是幂等的：不新增流水，也不排邮件。
    await seedDatabase(seeded.db);
    expect(await outboxCount(seeded)).toBe(0);
  });

  it('migrates an empty database from scratch', async () => {
    const empty = await freshDatabase(EMPTY);
    await migrate(empty.db, { migrationsFolder });
    expect(await outboxCount(empty)).toBe(0);
    const { rows } = await empty.pool.query<{ n: number }>(
      'select count(*)::int as n from balance_notice_state',
    );
    expect(rows).toEqual([{ n: 0 }]);
    const triggers = await empty.pool.query<{ tgname: string }>(
      `select tgname from pg_trigger
       where tgname in ('tenant_balances_notice', 'tenants_open_balance_notice') order by tgname`,
    );
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'tenant_balances_notice',
      'tenants_open_balance_notice',
    ]);
  });
});
