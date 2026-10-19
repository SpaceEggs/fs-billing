import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  authorize,
  parseDialedNumber,
  parseRateCsv,
  type Currency,
  type RateEntry,
} from '@fs-billing/rating';
import {
  adminTransaction,
  backendPid,
  connections,
  createTenant,
  deferred,
  pgError,
  waitForTenantLock,
} from '../test/support.js';
import { lockTenants, withAdmin, type Tx } from './client.js';
import { createRateVersion, loadRatingTenant } from './rates.js';

const { app, owner } = connections();

function entries(csv: string): readonly RateEntry<Currency>[] {
  const parsed = parseRateCsv(
    `ISO,Country,Destination Prefix,Description,Rate\n${csv}`,
    'CNY',
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.entries;
}

const CHINA = entries(',中国,86,,0.0500');
const CHINA_RAISED = entries(',中国,86,,0.0550');

const dbNow = async (tx: Tx) => {
  const { rows } = await tx.execute<{ ms: string }>(
    sql`select (extract(epoch from clock_timestamp()) * 1000)::bigint::text as ms`,
  );
  return new Date(Number(rows[0]!.ms));
};

const later = (days: number) => new Date(Date.now() + days * 86_400_000);

describe('费率版本', () => {
  it('同一费率表插入两个相同生效时间的版本，被唯一约束拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const at = new Date('2027-01-01T00:00:00+08:00');
    await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA, { effectiveFrom: at }),
    );
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        createRateVersion(tx, tenant.id, CHINA_RAISED, { effectiveFrom: at }),
      ),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'rate_versions_tenant_effective_from_key',
    });
  });

  it('已排定未来版本时修改当前版本（新建立即生效版本）被拒绝，并提示先改未来版本', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, CHINA));
    await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA_RAISED, {
        effectiveFrom: new Date('2030-01-01T00:00:00+08:00'),
      }),
    );
    const error = await pgError(
      withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, CHINA_RAISED)),
    );
    expect(error).toMatchObject({
      code: '23514',
      message: '已排定 2029-12-31 16:00:00+00 生效的新版本，请先修改该未来版本',
    });
  });

  it('取消（删除）未来版本后，可以修改当前版本', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, CHINA));
    const future = await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA_RAISED, {
        effectiveFrom: later(30),
      }),
    );
    await withAdmin(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(sql`delete from rate_versions where id = ${future.id}`);
    });
    await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA_RAISED),
    );
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute(sql`select count(*)::int as versions, (select count(*)::int from rate_entries where tenant_id = ${tenant.id}) as entries
                     from rate_versions where tenant_id = ${tenant.id}`),
    );
    expect(rows).toEqual([{ versions: 2, entries: 2 }]);
  });

  it('新版本不能早于当前版本（不能倒填历史）', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, CHINA));
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        createRateVersion(tx, tenant.id, CHINA_RAISED, {
          effectiveFrom: new Date('2020-01-01T00:00:00Z'),
        }),
      ),
    );
    expect(error.message).toMatch(/^新版本的生效时间必须晚于当前版本/);
  });

  it('已生效的版本及其条目不可修改、不可删除', async () => {
    const tenant = await createTenant(app, 'CNY');
    const version = await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA),
    );
    const attempts = [
      sql`update rate_entries set rate = 0.01 where rate_version_id = ${version.id}`,
      sql`delete from rate_entries where rate_version_id = ${version.id}`,
      sql`insert into rate_entries (tenant_id, rate_version_id, prefix, country, rate)
          values (${tenant.id}, ${version.id}, '44', '英国', 0.0200)`,
      sql`delete from rate_versions where id = ${version.id}`,
      sql`update rate_versions set effective_from = now() where id = ${version.id}`,
    ];
    const messages = [];
    for (const statement of attempts) {
      messages.push(
        (
          await pgError(
            withAdmin(app.db, async (tx) => {
              await lockTenants(tx, [tenant.id]);
              await tx.execute(statement);
            }),
          )
        ).message,
      );
    }
    expect(messages).toEqual([
      'permission denied for table rate_entries',
      '已生效的费率版本不可修改，请新建版本',
      '已生效的费率版本不可修改，请新建版本',
      '已生效的费率版本不可删除',
      'permission denied for table rate_versions',
    ]);
  });

  it('owner 修改费率版本或条目同样被触发器拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const version = await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA),
    );
    const messages = [];
    for (const statement of [
      'UPDATE rate_entries SET rate = 0.01 WHERE rate_version_id = $1',
      'UPDATE rate_versions SET effective_from = now() WHERE id = $1',
    ]) {
      messages.push(
        (await pgError(owner.pool.query(statement, [version.id]))).message,
      );
    }
    expect(messages).toEqual([
      '费率条目不可修改，请新建版本',
      '费率版本不可修改',
    ]);
  });

  it('事务在版本生效前开始，跨过生效时间后删除或修改被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const version = await withAdmin(app.db, async (tx) => {
      const { rows } = await tx.execute<{ ms: string }>(sql`
        select (extract(epoch from clock_timestamp() + interval '3 seconds') * 1000)::bigint::text as ms`);
      return createRateVersion(tx, tenant.id, CHINA, {
        effectiveFrom: new Date(Number(rows[0]!.ms)),
      });
    });

    const editor = await app.pool.connect();
    const rejected = async (
      client: PoolClient,
      text: string,
      params: unknown[],
    ) => {
      await client.query('SAVEPOINT rejected');
      const error = await pgError(client.query(text, params));
      await client.query('ROLLBACK TO SAVEPOINT rejected');
      return error;
    };
    try {
      await editor.query('BEGIN');
      await editor.query(`SELECT set_config('app.scope', 'admin', true)`);
      await editor.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]);
      const started = await editor.query<{
        still_future: boolean;
        wait_seconds: string;
      }>(
        `SELECT effective_from > transaction_timestamp() AS still_future,
                extract(epoch FROM (effective_from - clock_timestamp()))::text AS wait_seconds
         FROM rate_versions WHERE id = $1`,
        [version.id],
      );
      expect(started.rows[0]!.still_future).toBe(true);
      const wait = Number(started.rows[0]!.wait_seconds);
      expect(wait).toBeGreaterThan(0);
      await editor.query('SELECT pg_sleep($1::double precision + 0.3)', [wait]);
      const crossed = await editor.query<{
        past: boolean;
        txn_before: boolean;
      }>(
        `SELECT clock_timestamp() >= effective_from AS past,
                transaction_timestamp() < effective_from AS txn_before
         FROM rate_versions WHERE id = $1`,
        [version.id],
      );
      expect(crossed.rows[0]).toEqual({ past: true, txn_before: true });
      expect(
        await rejected(editor, 'DELETE FROM rate_versions WHERE id = $1', [
          version.id,
        ]),
      ).toMatchObject({ code: '42501', message: '已生效的费率版本不可删除' });
      expect(
        await rejected(
          editor,
          `INSERT INTO rate_entries (tenant_id, rate_version_id, prefix, country, rate)
           VALUES ($1, $2, '44', '英国', 0.0200)`,
          [tenant.id, version.id],
        ),
      ).toMatchObject({
        code: '42501',
        message: '已生效的费率版本不可修改，请新建版本',
      });
      expect(
        await rejected(
          editor,
          'DELETE FROM rate_entries WHERE rate_version_id = $1',
          [version.id],
        ),
      ).toMatchObject({
        code: '42501',
        message: '已生效的费率版本不可修改，请新建版本',
      });
    } finally {
      await editor.query('ROLLBACK');
      editor.release();
    }

    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute(sql`
        select (select count(*)::int from rate_versions where id = ${version.id}) as versions,
               (select prefix from rate_entries where rate_version_id = ${version.id}) as prefix`),
    );
    expect(rows).toEqual([{ versions: 1, prefix: '86' }]);
  });

  it('费率超过 4 位小数被拒绝，而不是被四舍五入', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await pgError(
      withAdmin(app.db, async (tx) => {
        const version = await createRateVersion(tx, tenant.id, []);
        await tx.execute(sql`insert into rate_entries (tenant_id, rate_version_id, prefix, country, rate)
                             values (${tenant.id}, ${version.id}, '86', '中国', 0.04505)`);
      }),
    );
    expect(error).toMatchObject({
      code: '23514',
      constraint: 'rate_entries_rate_check',
    });
  });

  it('删未来条目后插入，同时删除该版本，两个事务都提交', async () => {
    const tenant = await createTenant(app, 'CNY');
    const version = await withAdmin(app.db, (tx) =>
      createRateVersion(
        tx,
        tenant.id,
        entries(',中国,86,,0.0500\n,英国,44,,0.0200'),
        { effectiveFrom: new Date('2031-06-01T00:00:00Z') },
      ),
    );
    const editor = await app.pool.connect();
    const deleter = await app.pool.connect();
    const jobs: Promise<unknown>[] = [];
    try {
      const pidOf = async (client: PoolClient) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
      const deleterPid = await pidOf(deleter);

      await editor.query('BEGIN');
      await editor.query(`SELECT set_config('app.scope', 'admin', true)`);
      await editor.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]);
      await editor.query(
        `DELETE FROM rate_entries WHERE rate_version_id = $1 AND prefix = '44'`,
        [version.id],
      );

      const deleting = (async () => {
        await deleter.query('BEGIN');
        await deleter.query(`SELECT set_config('app.scope', 'admin', true)`);
        await deleter.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [
          tenant.id,
        ]);
        await deleter.query('DELETE FROM rate_versions WHERE id = $1', [
          version.id,
        ]);
      })();
      jobs.push(deleting);
      await waitForTenantLock(owner, deleterPid, tenant.id);

      await editor.query(
        `INSERT INTO rate_entries (tenant_id, rate_version_id, prefix, country, rate)
         VALUES ($1, $2, '1', '美国', 0.0100)`,
        [tenant.id, version.id],
      );
      await editor.query('COMMIT');
      await deleting;
      await deleter.query('COMMIT');

      const { rows } = await owner.pool.query(
        `SELECT
           (SELECT count(*)::int FROM rate_versions WHERE id = $1) AS versions,
           (SELECT count(*)::int FROM rate_entries WHERE tenant_id = $2) AS entries`,
        [version.id, tenant.id],
      );
      expect(rows).toEqual([{ versions: 0, entries: 0 }]);
    } finally {
      await editor.query('ROLLBACK').catch(() => undefined);
      await deleter.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(jobs);
      editor.release();
      deleter.release();
    }
  });
});

describe('同一租户的费率修改串行执行', () => {
  it('同时新建两个版本：后到的事务在租户锁上排队，再按已提交的版本校验', async () => {
    const tenant = await createTenant(app, 'CNY');
    const written = deferred();
    const release = deferred();
    const secondPid = deferred<number>();
    const first = adminTransaction(app.db, async (tx) => {
      await createRateVersion(tx, tenant.id, CHINA, {
        effectiveFrom: new Date('2031-01-01T00:00:00+08:00'),
      });
      written.resolve();
      await release.promise;
    });
    let second: Promise<unknown> = Promise.resolve();
    try {
      await Promise.race([written.promise, first]);
      second = adminTransaction(app.db, async (tx) => {
        secondPid.resolve(await backendPid(tx));
        await createRateVersion(tx, tenant.id, CHINA_RAISED, {
          effectiveFrom: new Date('2030-06-01T00:00:00+08:00'),
        });
      });
      await waitForTenantLock(owner, await secondPid.promise, tenant.id);
      release.resolve();
      await first;
      expect(await pgError(second)).toMatchObject({
        code: '23514',
        message:
          '已排定 2030-12-31 16:00:00+00 生效的新版本，请先修改该未来版本',
      });
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('两个事务各插一条未来条目后都删版本：后到的事务排队，版本删掉后它的插入报外键错误', async () => {
    const tenant = await createTenant(app, 'CNY');
    const version = await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA, {
        effectiveFrom: new Date('2031-06-01T00:00:00Z'),
      }),
    );
    const insertEntry = (tx: Tx, prefix: string) =>
      tx.execute(sql`insert into rate_entries (tenant_id, rate_version_id, prefix, country, rate)
                     values (${tenant.id}, ${version.id}, ${prefix}, '测试', 0.0100)`);
    const deleteVersion = (tx: Tx) =>
      tx.execute(sql`delete from rate_versions where id = ${version.id}`);

    const inserted = deferred();
    const release = deferred();
    const secondPid = deferred<number>();
    const first = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await insertEntry(tx, '44');
      inserted.resolve();
      await release.promise;
      await deleteVersion(tx);
    });
    let second: Promise<unknown> = Promise.resolve();
    try {
      await Promise.race([inserted.promise, first]);
      second = adminTransaction(app.db, async (tx) => {
        secondPid.resolve(await backendPid(tx));
        await lockTenants(tx, [tenant.id]);
        await insertEntry(tx, '1');
        await deleteVersion(tx);
      });
      await waitForTenantLock(owner, await secondPid.promise, tenant.id);
      release.resolve();
      await first;
      expect(await pgError(second)).toMatchObject({
        code: '23503',
        constraint: 'rate_entries_rate_version_id_tenant_id_fkey',
      });
      const { rows } = await owner.pool.query(
        `SELECT (SELECT count(*)::int FROM rate_versions WHERE tenant_id = $1) AS versions,
                (SELECT count(*)::int FROM rate_entries WHERE tenant_id = $1) AS entries`,
        [tenant.id],
      );
      expect(rows).toEqual([{ versions: 0, entries: 0 }]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});

describe('开户后立即授权', () => {
  it('首个立即生效版本的生效时间取数据库 now()，提交后马上授权能匹配到费率', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, CHINA));

    const result = await withAdmin(app.db, async (tx) => {
      const loaded = await loadRatingTenant(tx, tenant.code);
      const { rows } = await tx.execute(
        sql`select effective_from <= now() as effective from rate_versions where tenant_id = ${tenant.id}`,
      );
      return {
        rows,
        decision: authorize(
          loaded,
          parseDialedNumber('8613800138000')!,
          await dbNow(tx),
        ),
      };
    });

    expect(result.rows).toEqual([{ effective: true }]);
    expect(result.decision).toMatchObject({
      allowed: true,
      entry: { iso: '', description: '', prefix: '86', country: '中国' },
      callableMinutes: 2000,
      maxSeconds: 14400,
    });
  });

  it('对照：若生效时间取应用服务器时钟且快了几秒，开户后立即授权会是“无费率”', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) =>
      createRateVersion(tx, tenant.id, CHINA, {
        effectiveFrom: new Date(Date.now() + 5_000),
      }),
    );
    const decision = await withAdmin(app.db, async (tx) =>
      authorize(
        await loadRatingTenant(tx, tenant.code),
        parseDialedNumber('8613800138000')!,
        await dbNow(tx),
      ),
    );
    expect(decision).toEqual({ allowed: false, reason: '无费率' });
  });

  it('种子租户 ABC001：10 月 1 日前后 447 分别使用 0.0450 与 0.0480', async () => {
    const decide = (at: string) =>
      withAdmin(app.db, async (tx) => {
        const decision = authorize(
          await loadRatingTenant(tx, 'ABC001'),
          parseDialedNumber('447700900123')!,
          new Date(at),
        );
        return decision.allowed
          ? decision.entry.perMinute.perMinute.toFixed(4)
          : decision.reason;
      });
    expect([
      await decide('2026-09-30T23:59:59+08:00'),
      await decide('2026-10-01T00:00:00+08:00'),
    ]).toEqual(['0.0450', '0.0480']);
  });
});

it('stores ISO and description and returns each matched entry intact', async () => {
  const tenant = await createTenant(app, 'CNY');
  const rows = entries(
    'GB,英国,44,,0.0200\nGB,英国,447,手机,0.0450\n,国际网络,882,,0.1',
  );
  await withAdmin(app.db, (tx) => createRateVersion(tx, tenant.id, rows));
  const loaded = await withAdmin(app.db, (tx) =>
    loadRatingTenant(tx, tenant.code),
  );
  expect(loaded?.rates.versions[0]?.entries).toEqual(
    expect.arrayContaining([...rows]),
  );
});

it('rows inserted without ISO and description read back as empty strings and rejects invalid ISO', async () => {
  const tenant = await createTenant(app, 'CNY');
  const version = await withAdmin(app.db, (tx) =>
    createRateVersion(tx, tenant.id, [], { effectiveFrom: later(30) }),
  );
  const inserted = await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenant.id]);
    return tx.execute(
      sql`insert into rate_entries (tenant_id, rate_version_id, prefix, country, rate) values (${tenant.id},${version.id},'44','英国',0.02) returning iso, description`,
    );
  });
  expect(inserted.rows).toEqual([{ iso: '', description: '' }]);
  for (const iso of ['gb', 'GBR']) {
    expect(
      await pgError(
        withAdmin(owner.db, async (tx) => {
          await lockTenants(tx, [tenant.id]);
          return tx.execute(
            sql`insert into rate_entries (tenant_id, rate_version_id, prefix, country, rate, iso) values (${tenant.id},${version.id},'447','英国',0.04,${iso})`,
          );
        }),
      ),
    ).toMatchObject({ code: '23514', constraint: 'rate_entries_iso_check' });
  }
});

it('seed rates have GB/英国/empty for 44, GB/英国/手机 for 447 and empty ISO for 1', async () => {
  const tenant = await withAdmin(app.db, (tx) =>
    loadRatingTenant(tx, 'ABC001'),
  );
  for (const version of tenant!.rates.versions) {
    expect(
      version.entries.find((entry) => entry.prefix === '44'),
    ).toMatchObject({ iso: 'GB', country: '英国', description: '' });
    expect(
      version.entries.find((entry) => entry.prefix === '447'),
    ).toMatchObject({ iso: 'GB', country: '英国', description: '手机' });
    expect(version.entries.find((entry) => entry.prefix === '1')).toMatchObject(
      { iso: '' },
    );
  }
});
