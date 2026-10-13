import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import { lockTenants, withTenant } from './client.js';

const { app } = connections();

/** 在一条应用角色连接上执行 fn，结束时回滚、放掉会话级 advisory 锁并归还连接。 */
async function onAppClient<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await app.pool.connect();
  try {
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    await client.query('SELECT pg_advisory_unlock_all()');
    client.release();
  }
}

async function queryError(
  client: pg.PoolClient,
  text: string,
  values: unknown[],
) {
  return pgError(client.query(text, values));
}

describe('lock_tenants 只锁当前身份有权访问的租户', () => {
  it('租户身份锁其他租户报 42501；锁自己的租户可以', async () => {
    const own = await createTenant(app, 'CNY');
    const other = await createTenant(app, 'CNY');
    const error = await pgError(
      withTenant(app.db, own.id, (tx) => lockTenants(tx, [own.id, other.id])),
    );
    expect(error).toMatchObject({
      code: '42501',
      message: `当前身份不能锁租户 ${other.id}`,
    });
    await withTenant(app.db, own.id, (tx) => lockTenants(tx, [own.id]));
  });

  it('未设置身份的连接锁任何租户都报 42501', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await onAppClient(async (client) => {
      await client.query('BEGIN');
      return queryError(client, 'SELECT lock_tenants(ARRAY[$1]::uuid[])', [
        tenant.id,
      ]);
    });
    expect(error).toMatchObject({
      code: '42501',
      message: `当前身份不能锁租户 ${tenant.id}`,
    });
  });
});
