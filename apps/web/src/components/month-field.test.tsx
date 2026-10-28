import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MonthGrid, type MonthCellState } from './month-field';

const cells: Record<string, MonthCellState> = {
  '2026-08': { disabled: false, sub: '9,642 条' },
  '2026-09': {
    disabled: true,
    sub: '账单未生成',
    title: '本月账单尚未生成，不可选',
  },
  '2026-07': {
    disabled: true,
    sub: '未开户',
    title: '2026-08-12 开户前无话单',
  },
  '2026-10': { disabled: true, sub: '尚未到达', title: '尚未到达' },
};

function cell(month: string): MonthCellState {
  return cells[month] ?? { disabled: true };
}

describe('MonthGrid', () => {
  it('shows the sub-label and reason, and does not pick a disabled month', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onYearChange = vi.fn();
    render(
      <MonthGrid
        year={2026}
        minYear={2026}
        maxYear={2026}
        onYearChange={onYearChange}
        value="2026-08"
        onPick={onPick}
        cell={cell}
      />,
    );

    const september = screen.getByRole('button', {
      name: '2026年9月，账单未生成，本月账单尚未生成，不可选',
    });
    expect(september).toBeDisabled();
    expect(september).toHaveTextContent('账单未生成');
    expect(september).toHaveAttribute('title', '本月账单尚未生成，不可选');
    await user.click(september);
    expect(onPick).not.toHaveBeenCalled();

    const august = screen.getByRole('button', { name: '2026年8月，9,642 条' });
    expect(august).toBeEnabled();
    expect(august).toHaveTextContent('9,642 条');
    expect(august).toHaveAttribute('aria-pressed', 'true');
    await user.click(august);
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick).toHaveBeenCalledWith('2026-08');

    expect(screen.getByRole('button', { name: '2026年1月' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '上一年' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一年' })).toBeDisabled();
    expect(onYearChange).not.toHaveBeenCalled();
  });

  it('steps the year only inside the bounds', async () => {
    const user = userEvent.setup();
    const onYearChange = vi.fn();
    render(
      <MonthGrid
        year={2026}
        minYear={2025}
        maxYear={2027}
        onYearChange={onYearChange}
        value={null}
        onPick={vi.fn()}
        cell={() => ({ disabled: false })}
      />,
    );
    expect(screen.getByText('2026年')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '下一年' }));
    expect(onYearChange).toHaveBeenCalledTimes(1);
    expect(onYearChange).toHaveBeenCalledWith(2027);
    await user.click(screen.getByRole('button', { name: '上一年' }));
    expect(onYearChange).toHaveBeenLastCalledWith(2025);
    expect(screen.getByRole('button', { name: '2026年8月' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });
});
