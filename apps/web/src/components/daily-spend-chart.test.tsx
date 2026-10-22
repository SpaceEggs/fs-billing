import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DailyChart } from './daily-spend-chart';

const days = Array.from({ length: 30 }, (_, index) => ({
  date: `2026-09-${String(index + 1).padStart(2, '0')}`,
  spend: index === 29 ? '88.64' : index === 0 ? '80' : '10',
}));

const bubble = () => screen.queryByTestId('chart-bubble');
const dates = () =>
  [...screen.getByTestId('chart-dates').children].map((mark) => ({
    text: mark.textContent,
    phone: !mark.className.includes('hidden'),
  }));

describe('DailyChart', () => {
  it('marks 5 dates on a desktop and 3 on a phone for the admin overview', () => {
    render(<DailyChart currency="CNY" days={days} />);
    expect(dates()).toEqual([
      { text: '09-01', phone: true },
      { text: '09-08', phone: false },
      { text: '09-15', phone: true },
      { text: '09-22', phone: false },
      { text: '09-30', phone: true },
    ]);
  });

  it('marks 7 dates, 5 days apart, on desktop and phone for the portal home', () => {
    render(<DailyChart currency="CNY" days={days} variant="portal" />);
    expect(dates()).toEqual(
      ['09-01', '09-06', '09-11', '09-16', '09-21', '09-26', '09-30'].map(
        (text) => ({ text, phone: true }),
      ),
    );
  });

  it('shows no native title, and the bubble only after a pointer or a key', async () => {
    render(<DailyChart currency="CNY" days={days} />);
    const bars = screen.getAllByRole('listitem');
    for (const bar of bars) expect(bar).not.toHaveAttribute('title');
    expect(bubble()).toBeNull();
    await userEvent.hover(bars[29]!);
    // 气泡只有日期与金额，不含通数（决定 30）。
    expect(bubble()).toHaveTextContent('2026-09-30（今日）¥88.64');
    expect(bubble()).not.toHaveTextContent('通');
    await userEvent.unhover(bars[29]!);
    expect(bubble()).toBeNull();
  });

  it('keeps the bubble after a touch on a bar and closes it on a touch elsewhere', () => {
    render(
      <div>
        <button type="button">elsewhere</button>
        <DailyChart currency="CNY" days={days} />
      </div>,
    );
    fireEvent.pointerDown(screen.getAllByRole('listitem')[0]!, {
      pointerType: 'touch',
    });
    expect(bubble()).toHaveTextContent('2026-09-01¥80.00');
    fireEvent.pointerLeave(screen.getByRole('list'), { pointerType: 'touch' });
    expect(bubble()).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(bubble()).toBeNull();
  });

  it('can be read with the keyboard: Tab, arrows, Home, End and Escape', async () => {
    render(<DailyChart currency="CNY" days={days} />);
    await userEvent.tab();
    expect(screen.getByRole('list')).toHaveFocus();
    expect(bubble()).toHaveTextContent('2026-09-30（今日）¥88.64');
    await userEvent.keyboard('{ArrowLeft}');
    expect(bubble()).toHaveTextContent('2026-09-29¥10.00');
    await userEvent.keyboard('{Home}');
    expect(bubble()).toHaveTextContent('2026-09-01¥80.00');
    await userEvent.keyboard('{ArrowLeft}');
    expect(bubble()).toHaveTextContent('2026-09-01');
    await userEvent.keyboard('{End}');
    expect(bubble()).toHaveTextContent('2026-09-30（今日）');
    await userEvent.keyboard('{Escape}');
    expect(bubble()).toBeNull();
  });

  it('keeps the bubble inside the chart near both ends', async () => {
    render(<DailyChart currency="CNY" days={days} />);
    const bars = screen.getAllByRole('listitem');
    await userEvent.hover(bars[0]!);
    expect(bubble()).toHaveStyle({ left: '0px' });
    await userEvent.hover(bars[29]!);
    expect(bubble()).toHaveStyle({ right: '0px' });
    await userEvent.hover(bars[15]!);
    expect(bubble()?.style.transform).toBe('translateX(-50%)');
  });

  it('says there is no spend when every day is zero', () => {
    render(
      <DailyChart
        currency="CNY"
        days={days.map(({ date }) => ({ date, spend: '0' }))}
      />,
    );
    expect(screen.getByText('最近 30 天没有消费')).toBeInTheDocument();
  });
});
