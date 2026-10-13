import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { money } from '@fs-billing/rating';
import { connections, createTenant, pgError } from '../test/support.js';
import { lockTenants, withAdmin, withTenant } from './client.js';
import { appendLedgerEntry } from './ledger.js';

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

/** 成功返回 'ok'，数据库报错返回“SQLSTATE 消息”。 */
function outcome(promise: Promise<unknown>): Promise<string> {
  return pgError(promise).then(
    (error) => `${error.code} ${error.message}`,
    () => 'ok',
  );
}

async function balance(tenant: string): Promise<string> {
  const { rows } = await withTenant(app.db, tenant, (tx) =>
    tx.execute<{ balance: string }>(sql`select balance from tenant_balances`),
  );
  return rows[0]!.balance;
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

describe('已持有只认本事务通过 lock_tenants 拿到的锁', () => {
  const sessionLock = `SELECT pg_advisory_lock(hashtextextended('tenant:' || $1, 0))`;

  it('会话级同键 advisory 锁不能代替 lock_tenants 写流水', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await onAppClient(async (client) => {
      await client.query(sessionLock, [tenant.id]);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.scope', 'admin', true)`);
      return queryError(
        client,
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -1, 'call:session-lock')`,
        [tenant.id],
      );
    });
    expect(error).toMatchObject({
      code: '55000',
      message: `写租户 ${tenant.id} 的费率或流水之前，先在本事务调用 lock_tenants`,
    });
  });

  it('持有会话级同键锁时 lock_tenants 报 55000，而不是跳过加锁', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await onAppClient(async (client) => {
      await client.query(sessionLock, [tenant.id]);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.scope', 'admin', true)`);
      return queryError(client, 'SELECT lock_tenants(ARRAY[$1]::uuid[])', [
        tenant.id,
      ]);
    });
    expect(error).toMatchObject({
      code: '55000',
      message: `租户 ${tenant.id} 的锁要在本事务的任何写入、行锁和其他锁之前拿`,
    });
  });

  it('上一个事务的锁随提交释放，同一连接的下一个事务直接写入被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await onAppClient(async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.scope', 'admin', true)`);
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]);
      await client.query('COMMIT');
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.scope', 'admin', true)`);
      return queryError(
        client,
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -1, 'call:stale-connection')`,
        [tenant.id],
      );
    });
    expect(error).toMatchObject({ code: '55000' });
  });
});

describe('不调用 lock_tenants 的写入被拒绝', () => {
  it('直接插入流水和费率版本都报 55000，余额不变', async () => {
    const tenant = await createTenant(app, 'CNY');
    const ledger = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key)
                       values (${tenant.id}, 'call_charge', -1, 'call:no-lock')`),
      ),
    );
    const version = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(
          sql`insert into rate_versions (tenant_id) values (${tenant.id})`,
        ),
      ),
    );
    const message = `写租户 ${tenant.id} 的费率或流水之前，先在本事务调用 lock_tenants`;
    expect([ledger, version, await balance(tenant.id)]).toMatchObject([
      { code: '55000', message },
      { code: '55000', message },
      '0',
    ]);
  });
});

describe('先加行锁再等租户锁会被拒绝，不会死锁', () => {
  it('A 先 FOR UPDATE 租户行再 lock_tenants 报 55000；持锁的 B 照常写流水并提交', async () => {
    const tenant = await createTenant(app, 'CNY');
    const holder = await app.pool.connect();
    const locker = await app.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.scope', 'admin', true)`);
      await holder.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]);

      await locker.query('BEGIN');
      await locker.query(`SELECT set_config('app.scope', 'admin', true)`);
      await locker.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [
        tenant.id,
      ]);
      // 旧实现里 A 在这里排队等 B；B 的外键 KEY SHARE 再等 A 的行锁，1 秒后 B 收到 40P01。
      const [lockerOutcome, holderOutcome] = await Promise.all([
        outcome(
          locker.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]),
        ),
        outcome(
          (async () => {
            await holder.query(
              `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
               VALUES ($1, 'call_charge', -2, 'call:row-lock-first')`,
              [tenant.id],
            );
            await holder.query('COMMIT');
          })(),
        ),
      ]);
      expect({
        locker: lockerOutcome,
        holder: holderOutcome,
        balance: await balance(tenant.id),
      }).toEqual({
        locker: `55000 租户 ${tenant.id} 的锁要在本事务的任何写入、行锁和其他锁之前拿`,
        holder: 'ok',
        balance: '-2',
      });
    } finally {
      await locker.query('ROLLBACK');
      await holder.query('ROLLBACK');
      locker.release();
      holder.release();
    }
  });

  it('改过租户行的事务再调用 lockTenants 报 55000', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await pgError(
      withAdmin(app.db, async (tx) => {
        await tx.execute(
          sql`update tenants set remark = 'touched' where id = ${tenant.id}`,
        );
        await appendLedgerEntry(tx, tenant, {
          kind: 'call_charge',
          amount: money('CNY', '-1.00'),
          note: '',
          idempotencyKey: 'call:after-update',
          occurredAt: new Date(),
        });
      }),
    );
    expect(error).toMatchObject({
      code: '55000',
      message: `租户 ${tenant.id} 的锁要在本事务的任何写入、行锁和其他锁之前拿`,
    });
  });
});
