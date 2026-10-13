import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRateVersion,
  ensureCdrPartitions,
  lockTenants,
  withSystem,
} from '@fs-billing/db';
import { rate } from '@fs-billing/rating';
import { z } from 'zod';
import { fromDrizzle } from 'pg-boss';
import {
  connections,
  createTenant,
  pgError,
} from '../../../packages/db/test/support.js';
import { createWorker } from './app.js';
import { chargeCdr } from './charge.js';
import {
  maintainPartitions,
  startPartitionMaintenance,
} from './maintenance.js';
import {
  CHARGE_QUEUE,
  PARTITION_QUEUE,
  chargeQueue,
  createBoss,
  installQueue,
} from './queue.js';

const { app: connection, owner } = connections();
const boss = createBoss(connection.db);
const security = {
  secret: 'test-worker-key-123456',
  allowedIps: ['127.0.0.1'],
};
const worker = createWorker({
  db: connection.db,
  queue: chargeQueue(boss),
  security,
});
const template = z
  .looseObject({ variables: z.record(z.string(), z.unknown()) })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          '../../../freeswitch/examples/sample-cdr.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
function body(
  tenant: string,
  uuid: string,
  overrides: Record<string, unknown> = {},
) {
  return (
    JSON.stringify(
      {
        ...template,
        variables: {
          ...template.variables,
          uuid,
          billing_tenant: tenant,
          ...overrides,
        },
      },
      null,
      2,
    ) + '\n'
  );
}
const post = (payload: string, instance = worker) =>
  instance.inject({
    method: 'POST',
    url: '/cdr',
    headers: {
      'content-type': 'application/json',
      'x-billing-key': security.secret,
    },
    payload,
  });
async function fixture() {
  const tenant = await createTenant(connection, 'CNY');
  await withSystem(connection.db, (tx) =>
    createRateVersion(
      tx,
      tenant.id,
      [
        {
          prefix: '447',
          country: '英国手机',
          perMinute: rate('CNY', '0.0480'),
        },
      ],
      { effectiveFrom: new Date('2026-09-01T00:00:00Z') },
    ),
  );
  return tenant;
}
async function state(uuid: string) {
  return (
    await owner.pool.query<{
      cdrs: number;
      unassigned: number;
      charges: number;
      jobs: number;
    }>(
      `select (select count(*)::int from cdrs where call_uuid = $1) as cdrs,
      (select count(*)::int from unassigned_cdrs where call_uuid = $1) as unassigned,
      (select count(*)::int from ledger_entries where idempotency_key = 'call:' || $1::text) as charges,
      (select count(*)::int from pgboss.job where name = $2 and data->>'callUuid' = $1::text) as jobs`,
      [uuid, CHARGE_QUEUE],
    )
  ).rows[0];
}
beforeAll(async () => {
  await installQueue(owner);
  await boss.start();
});
afterAll(async () => {
  await worker.close();
  await boss.stop();
});

describe('Worker HTTP 与真实数据库', () => {
  it('真实格式样本推送两次：两份原文、一条话单、一个任务和一笔扣费；任务重复执行也不重扣', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const payload = body(tenant.code, uuid);
    const first = await post(payload);
    const second = await post(payload);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'queued' });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'duplicate' });
    expect(
      (
        await owner.pool.query(
          "select kind, tenant_id, affected_calls from system_alerts where kind = 'auth_timeout' and description like $1",
          [`${uuid}:%`],
        )
      ).rows,
    ).toEqual([
      { kind: 'auth_timeout', tenant_id: tenant.id, affected_calls: 1 },
    ]);
    expect(
      (
        await owner.pool.query('select body from raw_cdrs where body = $1', [
          payload,
        ])
      ).rows,
    ).toEqual([{ body: payload }, { body: payload }]);
    const jobs = await boss.fetch<unknown>(CHARGE_QUEUE, { batchSize: 100 });
    expect(jobs).toHaveLength(1);
    for (const job of jobs) {
      await chargeCdr(connection.db, job.data);
      await chargeCdr(connection.db, job.data);
      await boss.complete(CHARGE_QUEUE, job.id);
    }
    expect(await state(uuid)).toEqual({
      cdrs: 1,
      unassigned: 0,
      charges: 1,
      jobs: 1,
    });
    expect(
      (
        await owner.pool.query(
          'select unverified, charge::text, billed_minutes::text from cdrs where call_uuid = $1',
          [uuid],
        )
      ).rows,
    ).toEqual([{ unverified: true, charge: '0.192', billed_minutes: '4' }]);
    expect(
      (
        await owner.pool.query(
          'select amount::text, occurred_at from ledger_entries where idempotency_key = $1',
          [`call:${uuid}`],
        )
      ).rows,
    ).toEqual([
      { amount: '-0.192', occurred_at: new Date('2026-10-12T02:00:09Z') },
    ]);
    expect(
      (
        await owner.pool.query(
          'select balance::text from tenant_balances where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ balance: '-0.192' }]);
  });

  it.each(['075586001234', undefined])(
    'variables 缺少号码、callflow 主叫为 %s 时保存话单且只扣费一次',
    async (caller) => {
      const tenant = await fixture();
      const uuid = randomUUID();
      const payload = JSON.stringify({
        ...template,
        variables: {
          ...template.variables,
          uuid,
          billing_tenant: tenant.code,
          caller_id_number: undefined,
          destination_number: undefined,
        },
        callflow: [
          {
            caller_profile: {
              caller_id_number: caller,
              destination_number: '447700900123',
            },
          },
        ],
      });
      expect((await post(payload)).json()).toMatchObject({ status: 'queued' });
      expect((await post(payload)).json()).toMatchObject({
        status: 'duplicate',
      });
      const jobs = await boss.fetch<unknown>(CHARGE_QUEUE, { batchSize: 100 });
      expect(jobs).toHaveLength(1);
      for (const job of jobs) {
        await chargeCdr(connection.db, job.data);
        await chargeCdr(connection.db, job.data);
        await boss.complete(CHARGE_QUEUE, job.id);
      }
      expect(await state(uuid)).toEqual({
        cdrs: 1,
        unassigned: 0,
        charges: 1,
        jobs: 1,
      });
      expect(
        (
          await owner.pool.query(
            'select caller, callee, charge::text from cdrs where call_uuid = $1',
            [uuid],
          )
        ).rows,
      ).toEqual([
        { caller: caller ?? '', callee: '447700900123', charge: '0.192' },
      ]);
      expect(
        (
          await owner.pool.query(
            'select balance::text from tenant_balances where tenant_id = $1',
            [tenant.id],
          )
        ).rows,
      ).toEqual([{ balance: '-0.192' }]);
    },
  );

  it.each(['ABC01', '', 'UNKNOWN99'])(
    '租户标签 %s 进入 pending，并告警且不扣费',
    async (tag) => {
      const uuid = randomUUID();
      const payload = body(tag, uuid);
      expect((await post(payload)).json()).toMatchObject({
        status: 'unassigned',
      });
      expect((await post(payload)).json()).toMatchObject({
        status: 'duplicate',
      });
      expect(await state(uuid)).toEqual({
        cdrs: 0,
        unassigned: 1,
        charges: 0,
        jobs: 0,
      });
      expect(
        (
          await owner.pool.query(
            'select status, tenant_tag from unassigned_cdrs where call_uuid = $1',
            [uuid],
          )
        ).rows,
      ).toEqual([{ status: 'pending', tenant_tag: tag }]);
      expect(
        (
          await owner.pool.query(
            'select kind from system_alerts where description like $1 order by kind',
            [`${uuid}:%`],
          )
        ).rows,
      ).toEqual([{ kind: 'auth_timeout' }, { kind: 'cdr_failed' }]);
    },
  );

  it.each(['+447700900123', '00447700900123', '447x', ''])(
    '错误被叫 %s 返回 200，原文与未归属告警保留',
    async (callee) => {
      const tenant = await fixture();
      const uuid = randomUUID();
      const payload = body(tenant.code, uuid, { destination_number: callee });
      const response = await post(payload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'unassigned' });
      expect(await state(uuid)).toEqual({
        cdrs: 0,
        unassigned: 1,
        charges: 0,
        jobs: 0,
      });
      expect(
        (
          await owner.pool.query(
            'select reason, callee from unassigned_cdrs where call_uuid = $1',
            [uuid],
          )
        ).rows,
      ).toEqual([{ reason: '号码格式错误', callee }]);
      expect(
        (
          await owner.pool.query('select body from raw_cdrs where body = $1', [
            payload,
          ])
        ).rows,
      ).toEqual([{ body: payload }]);
      expect(
        (
          await owner.pool.query(
            'select kind from system_alerts where description = $1',
            [`${uuid}: 号码格式错误`],
          )
        ).rows,
      ).toEqual([{ kind: 'cdr_failed' }]);
    },
  );

  it.each(['{ "broken":'])(
    '损坏或缺字段的正文 %s 不返回 400，先保存原文并告警',
    async (payload) => {
      const response = await post(payload);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'invalid' });
      expect(
        (
          await owner.pool.query('select body from raw_cdrs where body = $1', [
            payload,
          ])
        ).rows,
      ).toEqual([{ body: payload }]);
      const result: { rawId: string } = response.json();
      expect(
        (
          await owner.pool.query(
            'select kind from system_alerts where description like $1',
            [`${result.rawId}:%`],
          )
        ).rows,
      ).toEqual([{ kind: 'cdr_failed' }]);
    },
  );

  it('接通时无费率进入待人工处理，不按零元计费', async () => {
    const tenant = await createTenant(connection, 'CNY');
    const uuid = randomUUID();
    expect((await post(body(tenant.code, uuid))).json()).toMatchObject({
      status: 'unassigned',
    });
    expect(
      (
        await owner.pool.query(
          'select reason from unassigned_cdrs where call_uuid = $1',
          [uuid],
        )
      ).rows,
    ).toEqual([{ reason: '接通时无费率' }]);
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 1,
      charges: 0,
      jobs: 0,
    });
  });

  it('缺分区返回 503 留给重推，保留原文并写 partition_failed，不在写入路径建分区', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const start = Math.floor(new Date('2034-06-01T00:00:00Z').getTime() / 1000);
    const payload = body(tenant.code, uuid, {
      start_epoch: start,
      answer_epoch: start + 9,
      end_epoch: start + 199,
    });
    expect((await post(payload)).statusCode).toBe(503);
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 0,
      charges: 0,
      jobs: 0,
    });
    expect(
      (
        await owner.pool.query(
          "select to_regclass('cdrs_2034_06') as partition",
        )
      ).rows,
    ).toEqual([{ partition: null }]);
    expect(
      (
        await owner.pool.query(
          "select kind from system_alerts where kind = 'partition_failed'",
        )
      ).rows.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await owner.pool.query('select body from raw_cdrs where body = $1', [
          payload,
        ])
      ).rows,
    ).toEqual([{ body: payload }]);
    await ensureCdrPartitions(connection.db, {
      moment: new Date('2034-06-01T00:00:00Z'),
    });
    expect((await post(payload)).json()).toMatchObject({ status: 'queued' });
    await chargeCdr(connection.db, { tenantId: tenant.id, callUuid: uuid });
    expect(await state(uuid)).toEqual({
      cdrs: 1,
      unassigned: 0,
      charges: 1,
      jobs: 1,
    });
  });

  it('原文分区缺失返回 503 并告警，恢复维护后重推成功', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const payload = body(tenant.code, uuid);
    const { rows } = await owner.pool.query(`select c.relname as name,
      pg_get_expr(c.relpartbound, c.oid) as bounds from pg_class c
      join pg_inherits i on i.inhrelid = c.oid
      where i.inhparent = 'raw_cdrs'::regclass and c.relname =
        'raw_cdrs_' || to_char(now() at time zone 'Asia/Shanghai', 'YYYY_MM')`);
    const partition = z
      .object({
        name: z.string().regex(/^raw_cdrs_\d{4}_\d{2}$/),
        bounds: z.string(),
      })
      .parse(rows[0]);
    await owner.pool.query(
      `alter table raw_cdrs detach partition ${partition.name}`,
    );
    try {
      expect((await post(payload)).statusCode).toBe(503);
      expect(await state(uuid)).toEqual({
        cdrs: 0,
        unassigned: 0,
        charges: 0,
        jobs: 0,
      });
      expect(
        (
          await owner.pool.query(
            'select kind from system_alerts where description like $1',
            ['no partition of relation "raw_cdrs" found for row%'],
          )
        ).rows,
      ).toEqual([{ kind: 'partition_failed' }]);
    } finally {
      await owner.pool.query(
        `alter table raw_cdrs attach partition ${partition.name} ${partition.bounds}`,
      );
    }
    expect((await post(payload)).json()).toMatchObject({ status: 'queued' });
    expect(
      (
        await owner.pool.query('select body from raw_cdrs where body = $1', [
          payload,
        ])
      ).rows,
    ).toEqual([{ body: payload }]);
  });

  it('入队失败回滚话单和 UUID 登记，原文保留，恢复后重推成功', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const payload = body(tenant.code, uuid);
    const failing = createWorker({
      db: connection.db,
      security,
      queue: { enqueue: () => Promise.reject(new Error('队列不可用')) },
    });
    try {
      expect((await post(payload, failing)).statusCode).toBe(503);
    } finally {
      await failing.close();
    }
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 0,
      charges: 0,
      jobs: 0,
    });
    expect((await post(payload)).json()).toMatchObject({ status: 'queued' });
    expect(
      (
        await owner.pool.query('select body from raw_cdrs where body = $1', [
          payload,
        ])
      ).rows,
    ).toHaveLength(2);
  });

  it('授权读取实时余额、状态与费率：放行或给出拒绝原因，错误号码返回 400', async () => {
    const tenant = await fixture();
    const authorize = (code: string, callee: string) =>
      worker.inject({
        method: 'POST',
        url: '/authorize',
        headers: { 'x-billing-key': security.secret },
        payload: { tenant: code, callee, uuid: randomUUID() },
      });
    expect((await authorize(tenant.code, '447700900123')).json()).toEqual({
      allowed: true,
      maxSeconds: 14400,
    });
    expect((await authorize('ABC01', '447700900123')).json()).toEqual({
      allowed: false,
      reason: '租户不存在',
      sipCode: 404,
    });
    expect((await authorize(tenant.code, '86138')).json()).toEqual({
      allowed: false,
      reason: '无费率',
      sipCode: 404,
    });
    for (const callee of ['+44', '0044', '44x', '']) {
      const response = await authorize(tenant.code, callee);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        allowed: false,
        reason: '号码格式错误',
        sipCode: 400,
      });
    }
    await withSystem(connection.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(
        sql`update tenants set status = 'disabled' where id = ${tenant.id}`,
      );
    });
    expect((await authorize(tenant.code, '447700900123')).json()).toEqual({
      allowed: false,
      reason: '租户已停用',
      sipCode: 403,
    });
  });

  it('同一 UUID 并发推送只入一条话单和一个任务', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const payload = body(tenant.code, uuid);
    const responses = await Promise.all([post(payload), post(payload)]);
    expect(responses.map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
    expect(
      responses
        .map((response) => response.json<{ status: string }>().status)
        .sort(),
    ).toEqual(['duplicate', 'queued']);
    expect(await state(uuid)).toEqual({
      cdrs: 1,
      unassigned: 0,
      charges: 0,
      jobs: 1,
    });
    expect(
      (
        await owner.pool.query('select body from raw_cdrs where body = $1', [
          payload,
        ])
      ).rows,
    ).toHaveLength(2);
  });

  it('已有未归属 UUID 改标签重推仍重复，HTTP 入库触发器也禁止并发认领', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    expect((await post(body('ABC01', uuid))).json()).toMatchObject({
      status: 'unassigned',
    });
    expect((await post(body(tenant.code, uuid))).json()).toMatchObject({
      status: 'duplicate',
    });
    const error = await pgError(
      withSystem(connection.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        await tx.execute(
          sql`select set_config('app.cdr_ingest', 'true', true)`,
        );
        await tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
        values (${tenant.id}, ${uuid}, '2026-10-12T02:00:00Z', '2026-10-12T02:00:00Z', '075586001234', '447700900123')`);
      }),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'call_uuids_pkey',
    });
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 1,
      charges: 0,
      jobs: 0,
    });
  });

  it('缺密钥或不在 IP 白名单的请求在保存正文前拒绝', async () => {
    for (const key of [
      'wrong',
      'x'.repeat(security.secret.length),
      '密钥错误',
    ]) {
      expect(
        (
          await worker.inject({
            method: 'POST',
            url: '/cdr',
            headers: { 'x-billing-key': key },
            payload: '{}',
          })
        ).statusCode,
      ).toBe(401);
    }
    expect(
      (await worker.inject({ method: 'POST', url: '/cdr', payload: '{}' }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await worker.inject({
          method: 'POST',
          url: '/cdr',
          remoteAddress: '10.1.2.3',
          headers: { 'x-billing-key': security.secret },
          payload: '{}',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('接通时刻选择整表版本，跨月处理仍按九月入账', async () => {
    const tenant = await fixture();
    await withSystem(connection.db, (tx) =>
      createRateVersion(
        tx,
        tenant.id,
        [
          {
            prefix: '447',
            country: '英国手机',
            perMinute: rate('CNY', '0.1000'),
          },
        ],
        { effectiveFrom: new Date('2026-09-30T16:00:00Z') },
      ),
    );
    for (const [answeredAt, amount, month] of [
      ['2026-09-30T15:59:00Z', '-0.192', '2026-09'],
      ['2026-09-30T16:00:00Z', '-0.4', '2026-10'],
    ]) {
      const uuid = randomUUID();
      const answer = Math.floor(new Date(answeredAt!).getTime() / 1000);
      expect(
        (
          await post(
            body(tenant.code, uuid, {
              start_epoch: answer - 9,
              answer_epoch: answer,
              end_epoch: answer + 190,
            }),
          )
        ).json(),
      ).toMatchObject({ status: 'queued' });
      await chargeCdr(connection.db, { tenantId: tenant.id, callUuid: uuid });
      expect(
        (
          await owner.pool.query(
            `select amount::text, occurred_at,
         to_char(occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month,
         created_at > '2026-09-30T16:00:00Z' as processed_later
         from ledger_entries where idempotency_key = $1`,
            [`call:${uuid}`],
          )
        ).rows,
      ).toEqual([
        {
          amount,
          occurred_at: new Date(answeredAt!),
          month,
          processed_later: true,
        },
      ]);
    }
  });

  it('授权有费率，接通时新版移除前缀：pending 与告警，不回退旧费率也不扣零元', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    const authorization = await worker.inject({
      method: 'POST',
      url: '/authorize',
      headers: { 'x-billing-key': security.secret },
      payload: { tenant: tenant.code, callee: '447700900123', uuid },
    });
    expect(authorization.json()).toMatchObject({ allowed: true });
    // 新版本在授权之后、接通之前生效；整表为空，不得沿用旧版前缀。
    const answer = Math.floor(Date.now() / 1000) + 60;
    await withSystem(connection.db, (tx) =>
      createRateVersion(tx, tenant.id, [], {
        effectiveFrom: new Date((answer - 1) * 1000),
      }),
    );
    expect(
      (
        await post(
          body(tenant.code, uuid, {
            start_epoch: answer - 9,
            answer_epoch: answer,
            end_epoch: answer + 190,
          }),
        )
      ).json(),
    ).toMatchObject({ status: 'unassigned' });
    expect(await state(uuid)).toEqual({
      cdrs: 0,
      unassigned: 1,
      charges: 0,
      jobs: 0,
    });
    expect(
      (
        await owner.pool.query(
          'select status, reason from unassigned_cdrs where call_uuid = $1',
          [uuid],
        )
      ).rows,
    ).toEqual([{ status: 'pending', reason: '接通时无费率' }]);
    expect(
      (
        await owner.pool.query(
          'select kind from system_alerts where description = $1',
          [`${uuid}: 接通时无费率`],
        )
      ).rows,
    ).toEqual([{ kind: 'cdr_failed' }]);
  });

  it('流水已插入后模拟崩溃：回滚余额，重新执行只扣一次', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    expect((await post(body(tenant.code, uuid))).json()).toMatchObject({
      status: 'queued',
    });
    // AFTER INSERT 时流水与余额触发器已运行；抛错模拟提交前崩溃并回滚事务。
    await owner.pool.query(`create function test_charge_crash() returns trigger
      language plpgsql security definer set search_path = public, pg_temp as $$
      begin
        if NEW.idempotency_key = TG_ARGV[0] then
          raise exception '模拟扣费提交前崩溃';
        end if;
        return NEW;
      end $$`);
    await owner.pool
      .query(`create trigger zz_test_charge_crash after insert on ledger_entries
      for each row execute function test_charge_crash('call:${uuid}')`);
    try {
      await expect(
        chargeCdr(connection.db, { tenantId: tenant.id, callUuid: uuid }),
      ).rejects.toThrow();
    } finally {
      await owner.pool.query(
        'drop trigger zz_test_charge_crash on ledger_entries',
      );
      await owner.pool.query('drop function test_charge_crash()');
    }
    expect((await state(uuid))?.charges).toBe(0);
    expect(
      (
        await owner.pool.query(
          'select balance::text from tenant_balances where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ balance: '0' }]);
    await Promise.all([
      chargeCdr(connection.db, { tenantId: tenant.id, callUuid: uuid }),
      chargeCdr(connection.db, { tenantId: tenant.id, callUuid: uuid }),
    ]);
    expect((await state(uuid))?.charges).toBe(1);
    expect(
      (
        await owner.pool.query(
          'select balance::text from tenant_balances where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ balance: '-0.192' }]);
  });

  it('扣费提交但任务未确认：重启队列，过期任务重投不重复扣费', async () => {
    const tenant = await fixture();
    const uuid = randomUUID();
    expect((await post(body(tenant.code, uuid))).json()).toMatchObject({
      status: 'queued',
    });
    const { rows } = await owner.pool.query<{ id: string }>(
      `select id from pgboss.job where name = $1 and data->>'callUuid' = $2`,
      [CHARGE_QUEUE, uuid],
    );
    const jobs = await boss.fetch<unknown>(CHARGE_QUEUE, { batchSize: 1000 });
    const job = jobs.find((entry) => entry.id === rows[0]?.id);
    expect(job).toBeDefined();
    if (!job) throw new Error('扣费任务未领取');
    await chargeCdr(connection.db, job.data);
    await boss.stop();
    // 推进这项任务的过期时间，避免等待默认的 15 分钟。
    await owner.pool.query(
      `update pgboss.job set started_on = now() - interval '1 hour'
      where name = $1 and id = $2`,
      [CHARGE_QUEUE, job.id],
    );
    const restarted = createBoss(connection.db);
    try {
      await restarted.start();
      await restarted.supervise(CHARGE_QUEUE);
      const redelivered = (
        await restarted.fetch<unknown>(CHARGE_QUEUE, { batchSize: 1000 })
      ).find((entry) => entry.id === job.id);
      expect(redelivered).toBeDefined();
      if (!redelivered) throw new Error('过期任务未重投');
      await chargeCdr(connection.db, redelivered.data);
      await restarted.complete(CHARGE_QUEUE, redelivered.id);
    } finally {
      await restarted.stop();
      await boss.start();
    }
    expect((await state(uuid))?.charges).toBe(1);
    expect(
      (
        await owner.pool.query(
          'select balance::text from tenant_balances where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ balance: '-0.192' }]);
  });

  it('pg-boss 维护 SQL 不提前提交调用方事务，后续失败时队列写入回滚', async () => {
    const uuid = randomUUID();
    await expect(
      withSystem(connection.db, async (tx) => {
        await lockTenants(tx, []);
        await fromDrizzle(tx, sql).executeSql(
          `BEGIN;
        insert into pgboss.schedule (name, key, cron, timezone, data, options)
        values ($1, $2, '0 0 * * *', 'Asia/Shanghai', '{}', '{}');
        COMMIT;`,
          [PARTITION_QUEUE, uuid],
        );
        throw new Error('模拟队列事务后续失败');
      }),
    ).rejects.toThrow('模拟队列事务后续失败');
    expect(
      (
        await owner.pool.query(
          'select key from pgboss.schedule where name = $1 and key = $2',
          [PARTITION_QUEUE, uuid],
        )
      ).rows,
    ).toEqual([]);
  });

  it('启动维护立即建分区，每日北京时间调度可重复运行', async () => {
    const { rows: months } = await owner.pool.query<{ suffix: string }>(
      `select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai') + interval '1 month', 'YYYY_MM') as suffix`,
    );
    const suffix = z
      .string()
      .regex(/^\d{4}_\d{2}$/)
      .parse(months[0]?.suffix);
    await owner.pool.query(`drop table cdrs_${suffix}, raw_cdrs_${suffix}`);
    await startPartitionMaintenance(boss, connection.db, worker.log);
    expect(
      (
        await owner.pool.query(
          'select to_regclass($1) as cdr, to_regclass($2) as raw',
          [`cdrs_${suffix}`, `raw_cdrs_${suffix}`],
        )
      ).rows,
    ).toEqual([{ cdr: `cdrs_${suffix}`, raw: `raw_cdrs_${suffix}` }]);
    const schedules = await boss.getSchedules(PARTITION_QUEUE);
    expect(schedules).toMatchObject([
      { cron: '0 0 * * *', timezone: 'Asia/Shanghai' },
    ]);
    await maintainPartitions(connection.db, worker.log);
    const id = await boss.send(PARTITION_QUEUE);
    expect(id).not.toBeNull();
    await expect
      .poll(
        async () =>
          (
            await owner.pool.query<{ state: string }>(
              'select state from pgboss.job where name = $1 and id = $2',
              [PARTITION_QUEUE, id],
            )
          ).rows[0]?.state,
        { timeout: 10000 },
      )
      .toBe('completed');
  });

  it('启动及维护任务失败写 partition_failed，错误向外抛出', async () => {
    await owner.pool.query(
      'revoke execute on function cdr_ensure_partitions(timestamptz, integer) from fs_billing_app',
    );
    try {
      for (const run of [
        () => startPartitionMaintenance(boss, connection.db, worker.log),
        () => maintainPartitions(connection.db, worker.log),
      ]) {
        await expect(run()).rejects.toThrow();
      }
    } finally {
      await owner.pool.query(
        'grant execute on function cdr_ensure_partitions(timestamptz, integer) to fs_billing_app',
      );
    }
    expect(
      (
        await owner.pool.query(`select kind from system_alerts
      where description like '话单分区维护失败:%'`)
      ).rows,
    ).toEqual([{ kind: 'partition_failed' }, { kind: 'partition_failed' }]);
  });
});
