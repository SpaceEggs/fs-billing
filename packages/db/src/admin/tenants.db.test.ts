import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  adminTenantCreateRequestSchema,
  adminTenantCreateResponseSchema,
  adminTenantDetailResponseSchema,
  adminTenantsQuerySchema,
  adminLedgerQuerySchema,
} from '@fs-billing/shared';
import { money } from '@fs-billing/rating';
import {
  connections,
  adminId,
  deferred,
  pgError,
  backendPid,
  waitForTenantLock,
} from '../../test/support.js';
import { withAdmin, lockTenants } from '../client.js';
import { appendLedgerEntry } from '../ledger.js';
import {
  createTenant,
  getTenant,
  editTenant,
  disableTenant,
  enableTenant,
  listTenants,
  updateTenantSettings,
} from './tenants.js';
import { operateBalance, listTenantLedger } from './balance.js';
import { rateVersions, operationLogs } from '../schema.js';

const { app, owner } = connections();
let actor: { id: string; name: string };
beforeAll(async () => {
  actor = { id: await adminId(owner), name: '管理员' };
});
const input = (currency: 'CNY' | 'USD' = 'CNY') =>
  adminTenantCreateRequestSchema.parse({
    code: `a${randomUUID().replaceAll('-', '')}`,
    name: '测试租户',
    currency,
    settings: { lowBalanceThreshold: '20' },
    initialRates: { kind: 'blank' },
  });
async function fixture(currency: 'CNY' | 'USD' = 'CNY') {
  return createTenant({
    db: app.db,
    actor,
    creatorEmail: 'ADMIN@example.com',
    request: input(currency),
  });
}
function balance(
  tenantId: string,
  amount = '20',
  idempotencyKey: string = randomUUID(),
) {
  return operateBalance({
    db: app.db,
    actor,
    tenantId,
    request: {
      kind: 'topup',
      amount,
      currency: 'CNY',
      note: '',
      idempotencyKey,
    },
  });
}

describe('admin tenant and balance services', () => {
  it('returns no audit id when a tenant mutation changes nothing', async () => {
    const created = await fixture();
    const tenantId = created.tenant.id;
    const detail = await getTenant({ db: app.db, tenantId });
    expect(
      await editTenant({
        db: app.db,
        actor,
        tenantId,
        request: {
          name: detail.name,
          contactName: detail.contactName,
          contactPhone: detail.contactPhone,
          remark: detail.remark,
        },
      }),
    ).toEqual({ auditId: null });
    const settings = {
      overdraftLimit: '50',
      lowBalanceThreshold: '5',
      emails: ['b@example.com'],
    };
    const saved = await updateTenantSettings({
      db: app.db,
      actor,
      tenantId,
      request: settings,
    });
    expect(saved.auditId).toEqual(expect.any(String));
    expect(
      await updateTenantSettings({
        db: app.db,
        actor,
        tenantId,
        request: settings,
      }),
    ).toEqual({ auditId: null });
    const disabled = await disableTenant({ db: app.db, actor, tenantId });
    expect(disabled.auditId).toEqual(expect.any(String));
    expect(await disableTenant({ db: app.db, actor, tenantId })).toEqual({
      auditId: null,
    });
    const enabled = await enableTenant({ db: app.db, actor, tenantId });
    expect(enabled.auditId).toEqual(expect.any(String));
    expect(await enableTenant({ db: app.db, actor, tenantId })).toEqual({
      auditId: null,
    });
  });

  it('creates an immediately effective empty version and explicit defaults', async () => {
    for (const currency of ['CNY', 'USD'] as const) {
      const result = adminTenantCreateResponseSchema.parse(
        await fixture(currency),
      );
      expect(result.tenant).toMatchObject({
        currency,
        status: 'active',
        settingsConfigured: true,
        balance: '0',
        settings: {
          overdraftLimit: currency === 'CNY' ? '100' : '15',
          lowBalanceThreshold: '20',
          emails: ['admin@example.com'],
        },
      });
      const versions = await withAdmin(app.db, (tx) =>
        tx
          .select({
            id: rateVersions.id,
            immediate: sql<boolean>`${rateVersions.effectiveFrom} <= now()`,
          })
          .from(rateVersions)
          .where(eq(rateVersions.tenantId, result.tenant.id)),
      );
      expect(versions).toEqual([
        { id: result.initialRateVersionId, immediate: true },
      ]);
    }
  });

  it('creates entries, CSV and copied initial rates and rejects foreign versions and currency mismatches atomically', async () => {
    const request = input();
    const source = await createTenant({
      db: app.db,
      actor,
      creatorEmail: 'admin@example.com',
      request: {
        ...request,
        initialRates: {
          kind: 'entries',
          entries: [{ prefix: '1', country: '美国', rate: '0.01' }],
        },
      },
    });
    const copy = {
      kind: 'copy' as const,
      sourceTenantId: source.tenant.id,
      sourceVersionId: source.initialRateVersionId,
    };
    const copied = await createTenant({
      db: app.db,
      actor,
      creatorEmail: 'admin@example.com',
      request: { ...input(), initialRates: copy },
    });
    expect(
      (
        await owner.pool.query(
          'select prefix,country,rate::text from rate_entries where tenant_id=$1',
          [copied.tenant.id],
        )
      ).rows,
    ).toEqual([{ prefix: '1', country: '美国', rate: '0.01' }]);
    const csv = await createTenant({
      db: app.db,
      actor,
      creatorEmail: 'admin@example.com',
      request: {
        ...input(),
        initialRates: {
          kind: 'csv',
          file: {
            filename: 'rates.csv',
            contentBase64: Buffer.from(
              'prefix,country,rate\n44,英国,0.04',
            ).toString('base64'),
          },
        },
      },
    });
    expect(
      (
        await owner.pool.query(
          'select prefix from rate_entries where tenant_id=$1',
          [csv.tenant.id],
        )
      ).rows,
    ).toEqual([{ prefix: '44' }]);
    for (const [currency, sourceTenantId, code] of [
      ['USD', source.tenant.id, 'CURRENCY_MISMATCH'],
      ['CNY', randomUUID(), 'NOT_FOUND'],
    ] as const) {
      const req = {
        ...input(currency),
        initialRates: { ...copy, sourceTenantId },
      };
      await expect(
        createTenant({
          db: app.db,
          actor,
          creatorEmail: 'admin@example.com',
          request: req,
        }),
      ).rejects.toMatchObject({ code });
      expect(
        (
          await owner.pool.query('select id from tenants where code=$1', [
            req.code,
          ])
        ).rows,
      ).toEqual([]);
    }
    for (const [content, code] of [
      [Buffer.from('44,英国,-1'), 'CSV_INVALID'],
      [Buffer.from([0xff]), 'CSV_ENCODING_UNSUPPORTED'],
    ] as const) {
      const req = {
        ...input(),
        initialRates: {
          kind: 'csv' as const,
          file: {
            filename: 'bad.csv',
            contentBase64: content.toString('base64'),
          },
        },
      };
      await expect(
        createTenant({
          db: app.db,
          actor,
          creatorEmail: 'admin@example.com',
          request: req,
        }),
      ).rejects.toMatchObject({ code });
      expect(
        (
          await owner.pool.query('select id from tenants where code=$1', [
            req.code,
          ])
        ).rows,
      ).toEqual([]);
    }
  });

  it('decodes GBK and rejects all post-parse row errors with physical line numbers and row limits', async () => {
    const request = {
      ...input(),
      initialRates: {
        kind: 'csv' as const,
        file: {
          filename: 'gbk.csv',
          contentBase64: Buffer.from(
            '7072656669782c636f756e7472792c726174650a312cd6d0b9fa2c302e3031',
            'hex',
          ).toString('base64'),
        },
      },
    };
    const created = await createTenant({
      db: app.db,
      actor,
      creatorEmail: 'admin@example.com',
      request,
    });
    expect(
      (
        await owner.pool.query(
          'select country from rate_entries where tenant_id=$1',
          [created.tenant.id],
        )
      ).rows,
    ).toEqual([{ country: '中国' }]);
    const long = '国'.repeat(201);
    await expect(
      createTenant({
        db: app.db,
        actor,
        creatorEmail: 'admin@example.com',
        request: {
          ...input(),
          initialRates: {
            kind: 'csv',
            file: {
              filename: 'long.csv',
              contentBase64: Buffer.from(
                `prefix,country,rate\n\n1,${long},0.01\n44,${long},0.02`,
              ).toString('base64'),
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'CSV_INVALID',
      rows: [{ line: 3 }, { line: 4 }],
    });
    const many = Array.from(
      { length: 10001 },
      (_, index) => `${index + 1},国家,0.01`,
    ).join('\n');
    await expect(
      createTenant({
        db: app.db,
        actor,
        creatorEmail: 'admin@example.com',
        request: {
          ...input(),
          initialRates: {
            kind: 'csv',
            file: {
              filename: 'many.csv',
              contentBase64: Buffer.from(many).toString('base64'),
            },
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'CSV_LIMIT_EXCEEDED' });
  });

  it('rejects code collisions without partial rows or audit and rolls back when audit validation fails', async () => {
    const request = input();
    await createTenant({
      db: app.db,
      actor,
      creatorEmail: 'admin@example.com',
      request,
    });
    await expect(
      createTenant({
        db: app.db,
        actor,
        creatorEmail: 'admin@example.com',
        request: { ...request, code: request.code.toLowerCase() },
      }),
    ).rejects.toMatchObject({ code: 'TENANT_CODE_EXISTS' });
    const failed = input();
    await expect(
      createTenant({
        db: app.db,
        actor: { ...actor, name: '' },
        creatorEmail: 'admin@example.com',
        request: failed,
      }),
    ).rejects.toThrow();
    expect(
      (
        await owner.pool.query('select id from tenants where code=$1', [
          failed.code,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('edits, disables, enables and normalizes settings with audits in the transaction', async () => {
    const f = await fixture();
    const tenantId = f.tenant.id;
    await editTenant({
      db: app.db,
      actor,
      tenantId,
      request: {
        name: '新名称',
        contactName: '联系人',
        contactPhone: '123',
        remark: '备注',
      },
    });
    await disableTenant({ db: app.db, actor, tenantId });
    for (const kind of ['topup', 'credit_topup', 'gift'] as const) {
      await operateBalance({
        db: app.db,
        actor,
        tenantId,
        request:
          kind === 'credit_topup'
            ? {
                kind,
                currency: 'CNY',
                amount: '1',
                idempotencyKey: randomUUID(),
                internalNote: '内部',
              }
            : {
                kind,
                currency: 'CNY',
                amount: '1',
                idempotencyKey: randomUUID(),
                note: '',
              },
      });
    }
    expect(await getTenant({ db: app.db, tenantId })).toMatchObject({
      name: '新名称',
      status: 'disabled',
      health: 'disabled',
      balance: '3',
      pendingReceivable: '1',
    });
    await enableTenant({ db: app.db, actor, tenantId });
    await updateTenantSettings({
      db: app.db,
      actor,
      tenantId,
      request: {
        overdraftLimit: '50',
        lowBalanceThreshold: '5',
        emails: ['B@example.com', 'b@example.com'],
      },
    });
    expect(
      adminTenantDetailResponseSchema.parse(
        await getTenant({ db: app.db, tenantId }),
      ),
    ).toMatchObject({
      status: 'active',
      health: 'low_balance',
      availableBalance: '53',
      settings: {
        overdraftLimit: '50',
        lowBalanceThreshold: '5',
        emails: ['b@example.com'],
      },
    });
    const audits = await withAdmin(app.db, (tx) =>
      tx
        .select()
        .from(operationLogs)
        .where(eq(operationLogs.tenantId, tenantId))
        .orderBy(operationLogs.id),
    );
    expect(audits).toHaveLength(8);
    for (const audit of audits) {
      expect(audit.createdAt).toBeInstanceOf(Date);
      expect(Number.isFinite(audit.createdAt.getTime())).toBe(true);
    }
    for (const [action, changes] of [
      [
        'tenant_edit',
        [
          { field: 'name', before: '测试租户', after: '新名称' },
          { field: 'contactName', before: '', after: '联系人' },
          { field: 'contactPhone', before: '', after: '123' },
          { field: 'remark', before: '', after: '备注' },
        ],
      ],
      [
        'tenant_disable',
        [{ field: 'status', before: 'active', after: 'disabled' }],
      ],
      [
        'tenant_enable',
        [{ field: 'status', before: 'disabled', after: 'active' }],
      ],
      [
        'tenant_settings_update',
        [
          { field: 'overdraftLimit', before: '100', after: '50' },
          { field: 'lowBalanceThreshold', before: '20', after: '5' },
          {
            field: 'emails',
            before: ['admin@example.com'],
            after: ['b@example.com'],
          },
        ],
      ],
    ] as const) {
      expect(audits.filter((audit) => audit.action === action)).toEqual([
        expect.objectContaining({
          adminId: actor.id,
          tenantId,
          target: tenantId,
          details: {
            actor,
            target: { kind: 'tenant', id: tenantId },
            content: { summary: action, changes },
          },
        }),
      ]);
    }
    await expect(
      withAdmin(app.db, async (tx) => {
        await editTenant({
          db: tx,
          actor,
          tenantId,
          request: {
            name: 'rollback',
            contactName: '',
            contactPhone: '',
            remark: '',
          },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await getTenant({ db: app.db, tenantId })).toMatchObject({
      name: '新名称',
    });
    expect(
      await withAdmin(app.db, (tx) =>
        tx
          .select()
          .from(operationLogs)
          .where(eq(operationLogs.tenantId, tenantId))
          .orderBy(operationLogs.id),
      ),
    ).toEqual(audits);
  });

  it('keeps currencies separate and groups status then currency before numeric balances', async () => {
    const prefix = `SORT${randomUUID().replaceAll('-', '')}`;
    for (const [suffix, currency, amount] of [
      ['A', 'USD', '1'],
      ['B', 'CNY', '100'],
      ['C', 'CNY', '2'],
    ] as const) {
      const created = await createTenant({
        db: app.db,
        actor,
        creatorEmail: 'admin@example.com',
        request: {
          ...input(currency),
          code: prefix + suffix,
          settings: { lowBalanceThreshold: '0' },
        },
      });
      await operateBalance({
        db: app.db,
        actor,
        tenantId: created.tenant.id,
        request: {
          kind: 'topup',
          currency,
          amount,
          note: '',
          idempotencyKey: randomUUID(),
        },
      });
    }
    const result = await listTenants({
      db: app.db,
      query: adminTenantsQuerySchema.parse({ search: prefix }),
    });
    expect(
      result.items.map((row) => [
        row.code.slice(-1),
        row.currency,
        row.balance,
      ]),
    ).toEqual([
      ['C', 'CNY', '2'],
      ['B', 'CNY', '100'],
      ['A', 'USD', '1'],
    ]);
    expect(result.pagination.total).toBe(3);
    expect(result).not.toHaveProperty('totalBalance');
  });

  it('orders all health states and respects suspension and low balance boundaries', async () => {
    const prefix = `HEALTH${randomUUID().replaceAll('-', '')}`;
    for (const [index, amount] of ['5', '1', '-1', '-10', '-20'].entries()) {
      const created = await createTenant({
        db: app.db,
        actor,
        creatorEmail: 'admin@example.com',
        request: {
          ...input(),
          code: `${prefix}${index}`,
          settings: { overdraftLimit: '10', lowBalanceThreshold: '5' },
        },
      });
      await operateBalance({
        db: app.db,
        actor,
        tenantId: created.tenant.id,
        request: {
          kind: 'adjustment',
          currency: 'CNY',
          amount,
          reason: '设置测试余额',
          idempotencyKey: randomUUID(),
        },
      });
      if (index === 4)
        await disableTenant({ db: app.db, actor, tenantId: created.tenant.id });
    }
    const result = await listTenants({
      db: app.db,
      query: adminTenantsQuerySchema.parse({ search: prefix }),
    });
    expect(result.items.map((row) => [row.health, row.balance])).toEqual([
      ['suspended', '-10'],
      ['overdraft', '-1'],
      ['low_balance', '1'],
      ['normal', '5'],
      ['disabled', '-20'],
    ]);
  });

  it('replays concurrent operations once, compares the complete payload and keeps credit pending', async () => {
    const f = await fixture();
    const tenantId = f.tenant.id;
    const request = {
      kind: 'credit_topup' as const,
      currency: 'CNY' as const,
      amount: '25.50',
      internalNote: '内部',
      idempotencyKey: randomUUID(),
    };
    const results = await Promise.all([
      operateBalance({ db: app.db, actor, tenantId, request }),
      operateBalance({ db: app.db, actor, tenantId, request }),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      balance: '25.5',
      entry: {
        kind: 'credit_recharge',
        note: '内部',
        paymentStatus: 'pending',
        noteVisibility: 'admin',
      },
    });
    expect(
      (
        await operateBalance({
          db: app.db,
          actor,
          tenantId,
          request: { ...request, amount: '25.5' },
        })
      ).auditId,
    ).toBe(results[0].auditId);
    for (const changed of [
      { ...request, internalNote: 'changed' },
      { ...request, amount: '26' },
      {
        kind: 'topup' as const,
        currency: request.currency,
        amount: request.amount,
        idempotencyKey: request.idempotencyKey,
        note: '',
      },
    ]) {
      await expect(
        operateBalance({ db: app.db, actor, tenantId, request: changed }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    await expect(
      operateBalance({
        db: app.db,
        actor,
        tenantId,
        request: { ...request, currency: 'USD' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(
      operateBalance({
        db: app.db,
        actor,
        tenantId,
        request: { ...request, currency: 'USD', idempotencyKey: randomUUID() },
      }),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
    expect(
      (
        await owner.pool.query(
          'select count(*)::int as n from operation_logs where tenant_id=$1 and action=$2',
          [tenantId, 'balance_credit_topup'],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('rejects missing adjustment reason, caps, precision and reserved keys before writing', async () => {
    const f = await fixture();
    const tenantId = f.tenant.id;
    for (const amount of ['1.001', '10000000000', '0', '-1'])
      await expect(balance(tenantId, amount)).rejects.toThrow();
    await expect(
      operateBalance({
        db: app.db,
        actor,
        tenantId,
        request: {
          kind: 'adjustment',
          currency: 'CNY',
          amount: '-1.0001',
          reason: '',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    await expect(balance(tenantId, '1', 'call:reserved')).rejects.toThrow();
    expect(
      await listTenantLedger({
        db: app.db,
        tenantId,
        query: adminLedgerQuerySchema.parse({}),
      }),
    ).toMatchObject({
      items: [],
      pagination: { total: 0 },
    });
    expect(
      await withAdmin(app.db, (tx) =>
        tx
          .select({ action: operationLogs.action })
          .from(operationLogs)
          .where(eq(operationLogs.tenantId, tenantId)),
      ),
    ).toEqual([{ action: 'tenant_create' }]);
    const valid = await operateBalance({
      db: app.db,
      actor,
      tenantId,
      request: {
        kind: 'adjustment',
        currency: 'CNY',
        amount: '-1.0001',
        reason: '冲正',
        idempotencyKey: randomUUID(),
      },
    });
    expect(valid.entry).toMatchObject({
      amount: '-1.0001',
      note: '冲正',
      balanceAfter: '-1.0001',
    });
    await expect(
      operateBalance({
        db: app.db,
        actor: { ...actor, name: '' },
        tenantId,
        request: {
          kind: 'gift',
          currency: 'CNY',
          amount: '100',
          note: '',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    expect(await getTenant({ db: app.db, tenantId })).toMatchObject({
      balance: '-1.0001',
    });
  });

  it('uses the existing tenant lock before state writes and preserves history before pagination', async () => {
    const f = await fixture();
    const tenantId = f.tenant.id;
    expect(
      (
        await pgError(
          withAdmin(app.db, (tx) =>
            tx.execute(
              sql`insert into ledger_entries(tenant_id,kind,amount,created_by,idempotency_key) values (${tenantId},'recharge',1,${actor.id},${randomUUID()})`,
            ),
          ),
        )
      ).code,
    ).toBe('55000');
    const locked = deferred();
    const release = deferred();
    const blocker = withAdmin(app.db, async (tx) => {
      await lockTenants(tx, [tenantId]);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pid = deferred<number>();
    const write = withAdmin(app.db, async (tx) => {
      pid.resolve(await backendPid(tx));
      return operateBalance({
        db: tx,
        actor,
        tenantId,
        request: {
          kind: 'topup',
          currency: 'CNY',
          amount: '10',
          note: '',
          idempotencyKey: randomUUID(),
        },
      });
    });
    try {
      await waitForTenantLock(owner, await pid.promise, tenantId);
      const result = await owner.pool.query(
        'select count(*)::int as n from ledger_entries where tenant_id=$1',
        [tenantId],
      );
      expect(result.rows).toEqual([{ n: 0 }]);
    } finally {
      release.resolve();
      await blocker;
    }
    await write;
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(
        tx,
        { id: tenantId, currency: 'CNY' },
        {
          kind: 'call_charge',
          amount: money('CNY', '-2'),
          note: '',
          idempotencyKey: `call:${randomUUID()}`,
          occurredAt: new Date('2000-01-01T00:00:00Z'),
        },
      ),
    );
    const page = await listTenantLedger({
      db: app.db,
      tenantId,
      query: adminLedgerQuerySchema.parse({ pageSize: 1, kind: 'recharge' }),
    });
    expect(page.items).toMatchObject([
      { kind: 'recharge', amount: '10', balanceAfter: '8' },
    ]);
    expect(page.pagination.total).toBe(1);
    const audits = await withAdmin(app.db, (tx) =>
      tx
        .select()
        .from(operationLogs)
        .where(eq(operationLogs.tenantId, tenantId)),
    );
    expect(audits).toHaveLength(2);
  });

  it('lists unconfigured tenants without inventing settings and treats search wildcards as literals', async () => {
    const code = `LEGACY${randomUUID().replaceAll('-', '')}`;
    const id = randomUUID();
    await owner.pool.query(
      "INSERT INTO tenants(id,code,name,currency,overdraft_limit) VALUES($1,$2,'存量','CNY',0)",
      [id, code],
    );
    await expect(getTenant({ db: app.db, tenantId: id })).rejects.toMatchObject(
      {
        code: 'SERVICE_UNAVAILABLE',
      },
    );
    const listed = await listTenants({
      db: app.db,
      query: adminTenantsQuerySchema.parse({ search: code }),
    });
    expect(listed.items).toEqual([
      expect.objectContaining({
        id,
        code,
        status: 'active',
        settingsConfigured: false,
        balance: '0',
        overdraftLimit: '0',
        health: 'suspended',
      }),
    ]);
    const wildcard = await listTenants({
      db: app.db,
      query: adminTenantsQuerySchema.parse({ search: `${code.slice(0, 6)}%` }),
    });
    expect(wildcard.items.map((item) => item.id)).not.toContain(id);
  });
});
