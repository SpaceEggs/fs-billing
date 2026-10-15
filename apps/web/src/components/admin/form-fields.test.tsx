import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RecipientsInput } from './form-fields';

describe('recipients input', () => {
  it('flags disabled-admin emails regardless of case and keeps the saved spelling', () => {
    render(
      <RecipientsInput
        emails={['WangMin@Example.com', 'billing@abc-tech.cn']}
        error={undefined}
        onChange={() => {}}
        flagged={new Set(['wangmin@example.COM'])}
      />,
    );
    const items = within(
      screen.getByRole('list', { name: '已添加的通知邮箱' }),
    ).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('WangMin@Example.com已停用管理员');
    expect(items[1]).not.toHaveTextContent('已停用管理员');
    expect(screen.getByRole('status')).toHaveTextContent(
      '「WangMin@Example.com」属于已停用管理员，请确认收件人',
    );
  });
});
