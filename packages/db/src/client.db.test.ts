import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { connections, pgError } from '../test/support.js';
import { withAdmin, withSystem } from './client.js';

const { app } = connections();

const raise = (code: string) =>
  sql.raw(
    `do $$ begin raise exception 'forced' using errcode = '${code}'; end $$`,
  );

describe('withAdmin / withSystem 重试', () => {
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
});
