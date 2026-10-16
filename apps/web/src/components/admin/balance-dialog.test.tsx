import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { clearBalanceAttempts } from '../../lib/balance-operation';
import { BalanceDialog } from './balance-dialog';

let tenantSeq = 0;
/** 幂等键按租户保留在模块内，每个用例用不同租户互不影响。 */
function tenantFixture(): AdminTenantDetailResponse {
  tenantSeq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(tenantSeq).padStart(12, '0')}`,
    code: 'ABC001',
    name: '深圳市某某科技有限公司',
    currency: 'CNY',
    status: 'active',
    health: 'overdraft',
    settingsConfigured: true,
    balance: '-35.2',
    overdraftLimit: '100',
    availableBalance: '64.8',
    monthConsumption: '0',
    pendingReceivable: '0',
    contactName: '',
    contactPhone: '',
    remark: '',
    settings: {
      overdraftLimit: '100',
      lowBalanceThreshold: '200',
      emails: [],
    },
    createdAt: '2026-08-12T02:31:02.000Z',
  };
}

function success(amount: string, balance: string) {
  return {
    auditId: '00000000-0000-4000-8000-0000000a0d17',
    currency: 'CNY',
    balance,
    entry: {
      id: '00000000-0000-4000-8000-0000000e0001',
      kind: 'adjustment',
      amount,
      balanceAfter: balance,
      note: '冲正',
      noteVisibility: 'customer',
      paymentStatus: null,
      actor: null,
      occurredAt: '2026-10-15T06:03:27.120Z',
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function renderDialog(
  tenant: AdminTenantDetailResponse,
  reply: (init: RequestInit) => Promise<Response>,
) {
  const keys: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_path: string, init: RequestInit) => {
      if (init.method === 'POST')
        keys.push(
          (JSON.parse(init.body as string) as { idempotencyKey: string })
            .idempotencyKey,
        );
      return reply(init);
    }),
  );
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          打开余额操作
        </button>
        <BalanceDialog
          owner="profile-admin-1"
          tenant={tenant}
          open={open}
          onOpenChange={setOpen}
          onViewLedger={() => {}}
          thresholds={{ CNY: '10000', USD: '1500' }}
        />
      </>
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return keys;
}

const dialog = () => screen.getByRole('dialog', { name: '余额操作' });

async function fillAdjustment(amount: string, note = '冲正') {
  const user = userEvent.setup();
  await user.click(within(dialog()).getByRole('radio', { name: '调账' }));
  await user.type(within(dialog()).getByLabelText(/^金额/), amount);
  await user.type(within(dialog()).getByLabelText(/备注/), note);
  await user.click(within(dialog()).getByRole('button', { name: '下一步' }));
}

const confirmButton = () =>
  within(dialog()).getByRole('button', { name: '确认调账' });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearBalanceAttempts();
});

describe('balance dialog', () => {
  it.each([
    ['-12.3456', '-47.5456', '-¥12.3456'],
    ['-0.0001', '-35.2001', '-¥0.0001'],
  ])(
    'confirms and reports %s at full precision',
    async (amount, balance, shown) => {
      renderDialog(tenantFixture(), () =>
        Promise.resolve(json(200, success(amount, balance))),
      );
      await fillAdjustment(amount);
      const confirm = within(dialog()).getByRole('button', {
        name: '确认调账',
      });
      expect(dialog()).toHaveTextContent(`金额${shown}`);

      await userEvent.click(confirm);
      expect(await within(dialog()).findByRole('status')).toHaveTextContent(
        `调账 ${shown} 已入账`,
      );
    },
  );

  it('cannot be dismissed while the operation is pending', async () => {
    const user = userEvent.setup();
    let respond: (response: Response) => void = () => {};
    const keys = renderDialog(
      tenantFixture(),
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await fillAdjustment('-20');
    await user.click(confirmButton());
    expect(keys).toHaveLength(1);

    await user.keyboard('{Escape}');
    fireEvent.pointerDown(document.body);
    expect(dialog()).toBeVisible();
    expect(
      within(dialog()).getByRole('button', { name: '返回修改' }),
    ).toBeDisabled();

    respond(json(200, success('-20', '-55.2')));
    expect(await within(dialog()).findByRole('status')).toHaveTextContent(
      '调账 -¥20.00 已入账，当前余额 -¥55.20',
    );
  });

  it('locks while fingerprinting and does not post an attempt voided by logout', async () => {
    const user = userEvent.setup();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          release = () => resolve(digest(...args));
        }),
    );
    const keys = renderDialog(tenantFixture(), () =>
      Promise.resolve(json(200, success('-20', '-55.2'))),
    );
    await fillAdjustment('-20');
    await user.click(confirmButton());
    expect(confirmButton()).toBeDisabled();
    expect(
      within(dialog()).getByRole('button', { name: '返回修改' }),
    ).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(dialog()).toBeVisible();

    clearBalanceAttempts();
    release();
    await vi.waitFor(() => expect(confirmButton()).toBeEnabled());
    expect(keys).toEqual([]);
  });

  it('reuses the idempotency key when an unknown outcome is retried after reopening', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const keys = renderDialog(tenantFixture(), () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new TypeError('Failed to fetch'))
        : Promise.resolve(json(200, success('-20', '-55.2')));
    });
    await fillAdjustment('-20');
    await user.click(confirmButton());
    expect(await within(dialog()).findByRole('alert')).toBeVisible();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '打开余额操作' }));
    await fillAdjustment('-20');
    await user.click(confirmButton());
    await within(dialog()).findByRole('status');
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    await user.click(within(dialog()).getByRole('button', { name: '完成' }));
    await user.click(screen.getByRole('button', { name: '打开余额操作' }));
    await fillAdjustment('-20');
    await user.click(confirmButton());
    await within(dialog()).findByRole('status');
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('a 200 whose body is lost keeps the key for the same amount at another scale', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const keys = renderDialog(tenantFixture(), () => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? new Response(
              new ReadableStream({
                start: (controller) =>
                  controller.error(new TypeError('network error')),
              }),
              { status: 200 },
            )
          : json(200, success('-20', '-55.2')),
      );
    });
    await fillAdjustment('-20');
    await user.click(confirmButton());
    expect(await within(dialog()).findByRole('alert')).toHaveTextContent(
      '网络中断',
    );

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '打开余额操作' }));
    await fillAdjustment('-20.0000');
    await user.click(confirmButton());
    await within(dialog()).findByRole('status');
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it('a definitive rejection does not keep the key for the same content', async () => {
    const user = userEvent.setup();
    const keys = renderDialog(tenantFixture(), () =>
      Promise.resolve(
        json(409, {
          error: {
            code: 'CURRENCY_MISMATCH',
            message: '币种不符',
            requestId: 'req-test',
          },
        }),
      ),
    );
    await fillAdjustment('-20');
    await user.click(confirmButton());
    await within(dialog()).findByRole('alert');
    await user.click(confirmButton());
    await vi.waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('operation type is a native radio group navigable by keyboard', async () => {
    const user = userEvent.setup();
    renderDialog(tenantFixture(), () => Promise.reject(new Error('unused')));
    const group = within(dialog()).getByRole('radiogroup', {
      name: '操作类型',
    });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('type'))).toEqual([
      'radio',
      'radio',
      'radio',
      'radio',
    ]);
    expect(within(group).getByRole('radio', { name: '充值' })).toBeChecked();

    within(group).getByRole('radio', { name: '充值' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(
      within(group).getByRole('radio', { name: '赊账充值' }),
    ).toBeChecked();
    expect(
      within(dialog()).getByText(/先加余额，记为「待收款」/),
    ).toBeVisible();
    await user.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: '充值' })).toBeChecked();
  });
});
