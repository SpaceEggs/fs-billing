import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PortalLedgerRow } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { Note } from './ledger';

const recharge: PortalLedgerRow = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'recharge',
  amount: '500.00',
  balanceAfter: '500.00',
  occurredAt: '2026-09-23T02:15:36.000Z',
  note: '账户充值',
  noteKey: 'ledger.accountRecharge',
};

const manual: PortalLedgerRow = {
  id: recharge.id,
  kind: recharge.kind,
  amount: recharge.amount,
  balanceAfter: recharge.balanceAfter,
  occurredAt: recharge.occurredAt,
  note: '银行转账',
};

describe('portal ledger note', () => {
  it('translates the system note key in Chinese', async () => {
    await renderWithLocale('zh', <Note row={recharge} />);
    expect(screen.getByText('账户充值')).toBeInTheDocument();
  });

  it('translates the system note key in English and leaves manual notes alone', async () => {
    const { rerender } = await renderWithLocale('en', <Note row={recharge} />);
    expect(screen.getByText('Account recharge')).toBeInTheDocument();
    expect(screen.queryByText('账户充值')).toBeNull();
    rerender(<Note row={manual} />);
    expect(screen.getByText('银行转账')).toBeInTheDocument();
  });
});
