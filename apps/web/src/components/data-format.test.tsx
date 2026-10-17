import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from './data-format';

describe('Money', () => {
  it.each([
    ['-12.3456', '-¥12.3456', 'text-neg'],
    ['-0.0001', '-¥0.0001', 'text-neg'],
    ['20.5', '+¥20.50', 'text-pos'],
    ['0.0001', '+¥0.0001', 'text-pos'],
  ])('exact %s shows %s with %s', (amount, shown, tone) => {
    render(<Money value={{ currency: 'CNY', amount }} tone="signed" exact />);
    expect(screen.getByText(shown)).toHaveClass(tone);
  });

  it('rounds to two decimals without exact', () => {
    render(
      <Money value={{ currency: 'CNY', amount: '-0.0001' }} tone="signed" />,
    );
    expect(screen.getByText('¥0.00')).toHaveClass('text-pos');
  });

  it('adds a plus to rounded positive signed amounts only', () => {
    render(
      <>
        <Money value={{ currency: 'USD', amount: '1234.565' }} tone="signed" />
        <Money value={{ currency: 'CNY', amount: '-88.64' }} tone="signed" />
        <Money value={{ currency: 'CNY', amount: '500' }} />
      </>,
    );
    expect(screen.getByText('+$1,234.57')).toHaveClass('text-pos');
    expect(screen.getByText('-¥88.64')).toHaveClass('text-neg');
    expect(screen.getByText('¥500.00')).not.toHaveClass('text-pos');
  });
});
