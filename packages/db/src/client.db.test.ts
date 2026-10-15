import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { money } from '@fs-billing/rating';
import { connections, createTenant, pgError } from '../test/support.js';
import { withAdmin, withSystem, withTenant } from './client.js';
import { appendLedgerEntry } from './ledger.js';

const { app } = connections();

const raise = (code: string) =>
  sql.raw(
    `do $$ begin raise exception 'forced' using errcode = '${code}'; end $$`,
  );

describe('withAdmin / withSystem 重试', () => {
  it('rejects nested isolation requests before running the callback', async () => {
    let calls = 0;
    for (const outerIsolation of [
      undefined,
      { isolationLevel: 'serializable' },
    ] as const) {
      await expect(
        app.db.transaction(
          (tx) =>
            withAdmin(
              tx,
              () => {
                calls += 1;
                return Promise.resolve();
              },
              { isolationLevel: 'serializable' },
            ),
          outerIsolation,
        ),
      ).rejects.toThrow(
        'Transaction isolation must be requested at the outermost layer',
      );
    }
    expect(calls).toBe(0);
  });

  it('applies SERIALIZABLE to an outermost admin transaction', async () => {
    const result = await withAdmin(
      app.db,
      (tx) =>
        tx.execute<{ isolation: string }>(
          sql`select current_setting('transaction_isolation') as isolation`,
        ),
      { isolationLevel: 'serializable' },
    );
    expect(result.rows).toEqual([{ isolation: 'serializable' }]);
  });

  it('40P01 与 40001 回滚后重跑整个事务', async () => {
    for (const [run, code] of [
      [withAdmin, '40P01'],
      [withSystem, '40001'],
    ] as const) {
      let attempts = 0;
      const result = await run(app.db, async (tx) => {
        attempts += 1;
        if (attempts === 1) await tx.execute(raise(code));
        const { rows } = await tx.execute<{ scope: string }>(
          sql`select current_setting('app.scope') as scope`,
        );
        return rows[0]!.scope;
      });
      expect({ code, attempts, result }).toEqual({
        code,
        attempts: 2,
        result: run === withAdmin ? 'admin' : 'system',
      });
    }
  });

  it('其他错误不重试；可重试的错误最多跑 3 次', async () => {
    let attempts = 0;
    const other = await pgError(
      withAdmin(app.db, async (tx) => {
        attempts += 1;
        await tx.execute(raise('23505'));
      }),
    );
    expect({ code: other.code, attempts }).toEqual({
      code: '23505',
      attempts: 1,
    });

    attempts = 0;
    const exhausted = await pgError(
      withSystem(app.db, async (tx) => {
        attempts += 1;
        await tx.execute(raise('40P01'));
      }),
    );
    expect({ code: exhausted.code, attempts }).toEqual({
      code: '40P01',
      attempts: 3,
    });
  });

  it('重试前的写入随回滚消失：只留下最后一次尝试写的流水', async () => {
    const tenant = await createTenant(app, 'CNY');
    let attempts = 0;
    await withAdmin(app.db, async (tx) => {
      attempts += 1;
      await appendLedgerEntry(tx, tenant, {
        kind: 'call_charge',
        amount: money('CNY', '-1.00'),
        note: '',
        idempotencyKey: `call:attempt-${attempts}`,
        occurredAt: new Date(),
      });
      if (attempts === 1) await tx.execute(raise('40P01'));
    });
    const { rows } = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute<{ keys: string[]; balance: string }>(
        sql`select array(select idempotency_key from ledger_entries order by idempotency_key) as keys,
                   (select balance from tenant_balances) as balance`,
      ),
    );
    expect({ attempts, ...rows[0] }).toEqual({
      attempts: 2,
      keys: ['call:attempt-2'],
      balance: '-1',
    });
  });

  it('嵌套调用不重试，错误抛给最外层，由最外层重跑整个事务', async () => {
    let outer = 0;
    let inner = 0;
    const result = await withAdmin(app.db, async (tx) => {
      outer += 1;
      return withSystem(tx, async (nested) => {
        inner += 1;
        if (outer === 1) await nested.execute(raise('40P01'));
        return 'done';
      });
    });
    expect({ result, outer, inner }).toEqual({
      result: 'done',
      outer: 2,
      inner: 2,
    });
  });

  it('嵌套调用遇到可重试的错误不在保存点里重跑：每次外层尝试只跑一次', async () => {
    let outer = 0;
    let inner = 0;
    const error = await pgError(
      withSystem(app.db, async (tx) => {
        outer += 1;
        await withAdmin(tx, async (nested) => {
          inner += 1;
          await nested.execute(raise('40001'));
        });
      }),
    );
    expect({ code: error.code, outer, inner }).toEqual({
      code: '40001',
      outer: 3,
      inner: 3,
    });
  });

  it('嵌套在普通 db.transaction 里：设置管理员身份，不重试，错误抛给外层', async () => {
    let inner = 0;
    let scope = '';
    const error = await pgError(
      app.db.transaction((tx) =>
        withAdmin(tx, async (nested) => {
          inner += 1;
          const { rows } = await nested.execute<{ scope: string }>(
            sql`select current_setting('app.scope') as scope`,
          );
          scope = rows[0]!.scope;
          await nested.execute(raise('40P01'));
        }),
      ),
    );
    expect({ code: error.code, inner, scope }).toEqual({
      code: '40P01',
      inner: 1,
      scope: 'admin',
    });
  });
});
