import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { latestRangeEnd } from '@fs-billing/shared';
import { DateRangeField } from './date-range-field';

describe('DateRangeField', () => {
  it('cannot confirm a range that ends after max', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DateRangeField
        label="日期范围"
        value={{ from: '2026-11-01', to: '2026-11-30' }}
        max="2026-10-17"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: /日期范围/ }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: '确定' });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows the one-month hint only when the range is limited', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DateRangeField
        label="日期范围"
        value={{ from: '2026-10-01', to: '2026-10-17' }}
        max="2026-10-17"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /日期范围/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('北京时间');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('最长一个月');
    await user.click(screen.getByRole('button', { name: '取消' }));
    rerender(
      <DateRangeField
        label="日期范围"
        value={{ from: '2026-10-01', to: '2026-10-17' }}
        max="2026-10-17"
        maxRangeEndForStart={latestRangeEnd}
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /日期范围/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent('最长一个月');
  });
});
