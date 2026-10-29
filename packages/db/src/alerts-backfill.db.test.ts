import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { AlertKeys, raiseAlert, recoverAlert } from './alerts.js';
import { connect, withSystem, type Connection } from './client.js';
import { seedDatabase } from './seed.js';

const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);
const SCRATCH = 'fs_billing_alerts_backfill';

/** 迁移 0020 之前的最后一个迁移的编号。 */
const LAST_BEFORE = 19;

function scratchUrl(): string {
  const url = new URL(inject('ownerUrl'));
  url.pathname = `/${SCRATCH}`;
  return url.toString();
}

let admin: Connection;
let scratch: Connection;
let folder: string;

beforeAll(async () => {
  admin = connect(inject('ownerUrl'));
  await admin.pool.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.pool.query(`CREATE DATABASE ${SCRATCH}`);
  scratch = connect(scratchUrl());
  // 只含 0000–0019 的迁移目录：先把库迁到阶段 8 的结构，再灌种子和历史告警，最后补上 0020。
  folder = await mkdtemp(join(tmpdir(), 'fsb-alerts-backfill-'));
  await cp(migrationsFolder, folder, { recursive: true });
  const journal = JSON.parse(
    await readFile(join(folder, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };
  journal.entries = journal.entries.filter((entry) => entry.idx <= LAST_BEFORE);
  await mkdir(join(folder, 'meta'), { recursive: true });
  await writeFile(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify(journal),
  );
  await migrate(scratch.db, { migrationsFolder: folder });
});

afterAll(async () => {
  await scratch.pool.end();
  await admin.pool.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
  await admin.pool.end();
  await rm(folder, { recursive: true, force: true });
});

describe('迁移 0020 的回填', () => {
  it('backfills legacy alerts without queueing any email and keys the open statement and archive alerts', async () => {
    const before = await scratch.pool.query(
      `select column_name from information_schema.columns
       where table_name = 'system_alerts' and column_name = 'subject_key'`,
    );
    expect(before.rows).toEqual([]);

    // 有种子数据的库：10 个租户、余额、阈值等，种子里没有告警。
    await seedDatabase(scratch.db);
    const { rows: tenants } = await scratch.pool.query<{
      id: string;
      code: string;
    }>('select id, code from tenants order by code limit 2');
    const [tenant, otherTenant] = tenants;
    expect(tenant && otherTenant).toBeTruthy();

    const longAgo = '2026-09-01T00:00:00Z';
    const statementText = (code: string) =>
      `${code} 2026-09 账单与流水不一致（stale），差额 -4`;
    const legacy = {
      statementOld: randomUUID(),
      statementDuplicate: randomUUID(),
      statementOther: randomUUID(),
      statementRecovered: randomUUID(),
      archive: randomUUID(),
      archiveRecovered: randomUUID(),
      cdr: randomUUID(),
      auth: randomUUID(),
    };
    const insert = (
      id: string,
      kind: string,
      tenantId: string | null,
      description: string,
      startedAt: string,
      recoveredAt: string | null,
    ) =>
      scratch.pool.query(
        `insert into system_alerts (id, kind, tenant_id, description, started_at, recovered_at, affected_calls)
         values ($1, $2, $3, $4, $5, $6, 3)`,
        [id, kind, tenantId, description, startedAt, recoveredAt],
      );
    await insert(
      legacy.statementOld,
      'statement_mismatch',
      tenant!.id,
      statementText(tenant!.code),
      longAgo,
      null,
    );
    // 同一个键的第二条未恢复旧行（旧逻辑会恢复掉多余的，正常不会出现）：只有最早的一条得到键。
    await insert(
      legacy.statementDuplicate,
      'statement_mismatch',
      tenant!.id,
      statementText(tenant!.code),
      '2026-09-02T00:00:00Z',
      null,
    );
    await insert(
      legacy.statementOther,
      'statement_mismatch',
      otherTenant!.id,
      statementText(otherTenant!.code),
      longAgo,
      null,
    );
    await insert(
      legacy.statementRecovered,
      'statement_mismatch',
      tenant!.id,
      statementText(tenant!.code),
      '2026-08-01T00:00:00Z',
      '2026-08-03T00:00:00Z',
    );
    await insert(
      legacy.archive,
      'raw_archive_failed',
      null,
      '原始话单归档 2022-05 失败（export）：x',
      longAgo,
      null,
    );
    await insert(
      legacy.archiveRecovered,
      'raw_archive_failed',
      null,
      '原始话单归档 2022-04 失败（export）：x',
      '2026-08-01T00:00:00Z',
      '2026-08-05T00:00:00Z',
    );
    await insert(
      legacy.cdr,
      'cdr_failed',
      null,
      `${randomUUID()}: 租户不存在`,
      longAgo,
      null,
    );
    await insert(
      legacy.auth,
      'auth_timeout',
      tenant!.id,
      `${randomUUID()}: FreeSWITCH 授权未验证，按 1800 秒放行`,
      longAgo,
      null,
    );
    const outboxTables = await scratch.pool.query(
      `select to_regclass('email_outbox') as outbox`,
    );
    expect(outboxTables.rows).toEqual([{ outbox: null }]);

    await migrate(scratch.db, { migrationsFolder });

    const { rows } = await scratch.pool.query<{
      id: string;
      subject_key: string | null;
      notify: boolean;
      occurrences: number;
      digest_cursor: number;
      last_digest_at: Date | null;
      affected_calls: number;
      last_seen_ok: boolean;
      notified_start_ok: boolean;
      notified_recovered_ok: boolean;
      recovered: boolean;
    }>(
      `select id, subject_key, notify, occurrences, digest_cursor, last_digest_at, affected_calls,
              last_seen_at = coalesce(recovered_at, started_at) as last_seen_ok,
              notified_start_at = started_at as notified_start_ok,
              notified_recovered_at is not distinct from recovered_at as notified_recovered_ok,
              recovered_at is not null as recovered
       from system_alerts`,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(rows).toHaveLength(Object.keys(legacy).length);
    for (const row of rows) {
      // 历史告警不发邮件：notify 为假，开始与恢复都标记为已通知。
      expect(row).toMatchObject({
        notify: false,
        occurrences: 1,
        digest_cursor: 0,
        last_digest_at: null,
        affected_calls: 3,
        last_seen_ok: true,
        notified_start_ok: true,
        notified_recovered_ok: true,
      });
    }
    expect(byId.get(legacy.statementOld)?.subject_key).toBe(
      `statement:${tenant!.id}:2026-09`,
    );
    expect(byId.get(legacy.statementDuplicate)?.subject_key).toBeNull();
    expect(byId.get(legacy.statementOther)?.subject_key).toBe(
      `statement:${otherTenant!.id}:2026-09`,
    );
    expect(byId.get(legacy.archive)?.subject_key).toBe('archive:2022-05');
    // 已恢复的旧行、以及没有结构化身份的旧行不回填键。
    for (const id of [
      legacy.statementRecovered,
      legacy.archiveRecovered,
      legacy.cdr,
      legacy.auth,
    ])
      expect(byId.get(id)?.subject_key).toBeNull();

    // 之后沿用新逻辑：同一个键的新事件并入回填的旧行，恢复也找得到它。
    const merged = await withSystem(scratch.db, (tx) =>
      raiseAlert(tx, {
        kind: 'raw_archive_failed',
        subjectKey: AlertKeys.archive('2022-05'),
        description: '再次失败',
      }),
    );
    expect(merged).toEqual({ id: legacy.archive, opened: false });
    expect(
      await withSystem(scratch.db, (tx) =>
        recoverAlert(tx, {
          kind: 'statement_mismatch',
          subjectKey: AlertKeys.statement(tenant!.id, '2026-09'),
        }),
      ),
    ).toBe(1);
    expect(
      (
        await scratch.pool.query(
          `select occurrences from system_alerts where id = $1`,
          [legacy.archive],
        )
      ).rows,
    ).toEqual([{ occurrences: 2 }]);
  });

  it('migrates an empty database from scratch', async () => {
    const empty = 'fs_billing_alerts_empty';
    await admin.pool.query(`DROP DATABASE IF EXISTS ${empty} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${empty}`);
    const url = new URL(inject('ownerUrl'));
    url.pathname = `/${empty}`;
    const connection = connect(url.toString());
    try {
      await migrate(connection.db, { migrationsFolder });
      const { rows } = await connection.pool.query<{ n: number }>(
        'select count(*)::int as n from system_alerts',
      );
      expect(rows).toEqual([{ n: 0 }]);
      const indexes = await connection.pool.query<{ indexname: string }>(
        `select indexname from pg_indexes where tablename = 'system_alerts' order by indexname`,
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        'system_alerts_open',
        'system_alerts_open_subject',
        'system_alerts_pkey',
        'system_alerts_started_at',
      ]);
    } finally {
      await connection.pool.end();
      await admin.pool.query(`DROP DATABASE IF EXISTS ${empty} WITH (FORCE)`);
    }
  });
});
