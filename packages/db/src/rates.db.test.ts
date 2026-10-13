import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  authorize,
  parseDialedNumber,
  parseRateCsv,
  type Currency,
  type RateEntry,
} from '@fs-billing/rating';
import { connections, createTenant, pgError } from '../test/support.js';
import { withAdmin, type Tx } from './client.js';
import { createRateVersion, loadRatingTenant } from './rates.js';

const { app, owner } = connections();

function entries(csv: string): readonly RateEntry<Currency>[] {
  const parsed = parseRateCsv(`prefix,country,rate\n${csv}`, 'CNY');
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.entries;
}

const CHINA = entries('86,中国,0.0500');
const CHINA_RAISED = entries('86,中国,0.0550');

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
    await withAdmin(app.db, (tx) =>
      tx.execute(sql`delete from rate_versions where id = ${future.id}`),
    );
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
        (await pgError(withAdmin(app.db, (tx) => tx.execute(statement))))
          .message,
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
      entry: { prefix: '86', country: '中国' },
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
