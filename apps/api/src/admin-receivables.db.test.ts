import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminBalanceOperationResponseSchema,
  adminConfirmPaymentResponseSchema,
  adminReceivablesResponseSchema,
  adminReversePaymentResponseSchema,
  adminVoidReceivableResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let cookie: string;
beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
});
async function credit(
  tenantId: string,
  currency: 'CNY' | 'USD',
  amount: string,
) {
  const response = await api.inject({
    method: 'POST',
    url: `/api/admin/tenants/${tenantId}/balance-operations`,
    headers: requestHeaders(cookie),
    payload: {
      kind: 'credit_topup',
      currency,
      amount,
      internalNote: '内部赊账测试',
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return adminBalanceOperationResponseSchema.parse(response.json()).entry.id;
}
async function mutate(id: string, action: string, payload: object) {
  return api.inject({
    method: 'POST',
    url: `/api/admin/receivables/${id}/${action}`,
    headers: requestHeaders(cookie),
    payload,
  });
}
async function list(query: string) {
  const response = await api.inject({
    url: `/api/admin/receivables?${query}`,
    headers: requestHeaders(cookie),
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return adminReceivablesResponseSchema.parse(response.json());
}
async function today() {
  const result = await connections.owner.pool.query<{ today: string }>(
    "select (clock_timestamp() at time zone 'Asia/Shanghai')::date::text as today",
  );
  return result.rows[0]!.today;
}
async function audit(id: string, action: string) {
  const result = await connections.owner.pool.query<{
    action: string;
    details: { content: object };
  }>('select action,details from operation_logs where id=$1', [id]);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.action).toBe(action);
  return result.rows[0]!.details.content;
}

describe('admin receivables HTTP', () => {
  it('keeps exact CNY and USD totals over the full filtered set before pagination', async () => {
    await credit(fixture.a.tenantId!, 'CNY', '9007199254.91');
    await credit(fixture.a2.tenantId!, 'CNY', '0.01');
    await credit(fixture.b.tenantId!, 'USD', '12.34');
    const page = await list(
      `search=${fixture.prefix.replaceAll('-', '')}&pageSize=1`,
    );
    expect(page.items).toHaveLength(1);
    expect(page.pagination.total).toBe(3);
    expect(page.totals).toEqual({ CNY: '9007199254.92', USD: '12.34' });
    const cny = await list(
      `search=${fixture.prefix.replaceAll('-', '')}&currency=CNY`,
    );
    expect(cny.items).toHaveLength(2);
    expect(cny.totals).toEqual({ CNY: '9007199254.92', USD: '0' });
    const emptyPage = await list(
      `search=${fixture.prefix.replaceAll('-', '')}&page=100`,
    );
    expect(emptyPage.items).toEqual([]);
    expect(emptyPage.totals).toEqual(page.totals);
  });

  it('confirms and reverses without changing balance, rejects stale tokens and records event audits', async () => {
    const id = await credit(fixture.a.tenantId!, 'CNY', '27.45');
    const balanceBefore = await connections.owner.pool.query(
      'select balance from tenant_balances where tenant_id=$1',
      [fixture.a.tenantId],
    );
    const confirmBody = {
      expectedLatestSettlementId: null,
      receivedOn: await today(),
      note: '到账',
    };
    const response = await mutate(id, 'confirm-payment', confirmBody);
    expect(response.statusCode, response.body).toBe(200);
    const received = adminConfirmPaymentResponseSchema.parse(response.json());
    expect(await audit(received.auditId, 'receivable_confirm')).toMatchObject({
      ledgerEntryId: id,
      settlementId: received.settlementId,
      amount: '27.45',
    });
    const receivedList = await list(
      `status=received&search=A${fixture.prefix.replaceAll('-', '')}`,
    );
    expect(
      receivedList.items.find((row) => row.ledgerEntryId === id),
    ).toMatchObject({
      latestSettlementId: received.settlementId,
      payment: { status: 'received', note: '到账' },
      overdue: false,
    });
    const duplicate = await mutate(id, 'confirm-payment', confirmBody);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: 'ALREADY_RECEIVED' },
    });
    const reverse = await mutate(id, 'reverse-payment', {
      settlementId: received.settlementId,
      reason: '录入有误',
    });
    expect(reverse.statusCode, reverse.body).toBe(200);
    const reversed = adminReversePaymentResponseSchema.parse(reverse.json());
    expect(
      await audit(reversed.auditId, 'receivable_payment_reverse'),
    ).toMatchObject({
      reversalId: reversed.reversalId,
      settlementId: received.settlementId,
      reason: '录入有误',
    });
    for (const stale of [
      await mutate(id, 'reverse-payment', {
        settlementId: received.settlementId,
        reason: '重复',
      }),
      await mutate(id, 'confirm-payment', confirmBody),
    ]) {
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({
        error: { code: 'SETTLEMENT_CONFLICT' },
      });
    }
    const pending = await list(
      `status=pending&search=A${fixture.prefix.replaceAll('-', '')}`,
    );
    expect(pending.items.find((row) => row.ledgerEntryId === id)).toMatchObject(
      {
        latestSettlementId: received.settlementId,
        payment: { status: 'pending' },
      },
    );
    expect(
      (
        await connections.owner.pool.query(
          'select balance from tenant_balances where tenant_id=$1',
          [fixture.a.tenantId],
        )
      ).rows,
    ).toEqual(balanceBefore.rows);
  });

  it('voids only a linked opposite adjustment and returns void conflict before other state errors', async () => {
    const id = await credit(fixture.a2.tenantId!, 'CNY', '19.25');
    const adjustment = await api.inject({
      method: 'POST',
      url: `/api/admin/tenants/${fixture.a2.tenantId}/balance-operations`,
      headers: requestHeaders(cookie),
      payload: {
        kind: 'adjustment',
        currency: 'CNY',
        amount: '-19.25',
        reason: '冲正',
        idempotencyKey: randomUUID(),
      },
    });
    expect(adjustment.statusCode, adjustment.body).toBe(200);
    const adjustmentId = adminBalanceOperationResponseSchema.parse(
      adjustment.json(),
    ).entry.id;
    const mismatch = await mutate(id, 'void', {
      adjustmentLedgerEntryId: randomUUID(),
      reason: '错误关联',
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: { code: 'RECEIVABLE_REVERSAL_MISMATCH' },
    });
    const balance = await connections.owner.pool.query(
      'select balance from tenant_balances where tenant_id=$1',
      [fixture.a2.tenantId],
    );
    const response = await mutate(id, 'void', {
      adjustmentLedgerEntryId: adjustmentId,
      reason: '已冲正',
    });
    expect(response.statusCode, response.body).toBe(200);
    const voided = adminVoidReceivableResponseSchema.parse(response.json());
    expect(await audit(voided.auditId, 'receivable_void')).toMatchObject({
      voidId: voided.voidId,
      adjustmentLedgerEntryId: adjustmentId,
      reason: '已冲正',
    });
    for (const response of [
      await mutate(id, 'confirm-payment', {
        expectedLatestSettlementId: null,
        receivedOn: await today(),
      }),
      await mutate(id, 'reverse-payment', {
        settlementId: randomUUID(),
        reason: '错误',
      }),
      await mutate(id, 'void', {
        adjustmentLedgerEntryId: adjustmentId,
        reason: '重复',
      }),
    ]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { code: 'RECEIVABLE_VOIDED' },
      });
    }
    const history = await list(
      `status=voided&search=A2${fixture.prefix.replaceAll('-', '')}`,
    );
    expect(
      history.items.find((row) => row.ledgerEntryId === id)?.payment,
    ).toMatchObject({
      status: 'voided',
      voidId: voided.voidId,
      reason: '已冲正',
    });
    expect(history.totals).toEqual({ CNY: '19.25', USD: '0' });
    expect(
      (
        await connections.owner.pool.query(
          'select balance from tenant_balances where tenant_id=$1',
          [fixture.a2.tenantId],
        )
      ).rows,
    ).toEqual(balance.rows);
  });

  it('requires admin identity for list and all mutations even with forged tenant headers', async () => {
    const customer = (await login(api, fixture.a)).cookie;
    const id = await credit(fixture.b.tenantId!, 'USD', '1');
    for (const [action, payload] of [
      [
        'confirm-payment',
        { expectedLatestSettlementId: null, receivedOn: await today() },
      ],
      ['reverse-payment', { settlementId: randomUUID(), reason: '攻击' }],
      ['void', { adjustmentLedgerEntryId: randomUUID(), reason: '攻击' }],
    ] as const) {
      const response = await api.inject({
        method: 'POST',
        url: `/api/admin/receivables/${id}/${action}`,
        headers: {
          ...requestHeaders(customer),
          'x-role': 'admin',
          'x-tenant-id': fixture.b.tenantId!,
        },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(
      (
        await api.inject({
          url: '/api/admin/receivables',
          headers: requestHeaders(customer),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await connections.owner.pool.query(
          'select id from receivable_settlements where ledger_entry_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([]);
  });
});
