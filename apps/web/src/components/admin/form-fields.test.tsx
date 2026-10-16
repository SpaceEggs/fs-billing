import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('stacked: adds the typed email with the 添加 button (稿 1h)', async () => {
    function Stacked() {
      const [emails, setEmails] = useState(['billing@abc-tech.cn']);
      return (
        <RecipientsInput
          stacked
          emails={emails}
          error={undefined}
          onChange={setEmails}
        />
      );
    }
    const user = userEvent.setup();
    render(<Stacked />);
    await user.type(screen.getByLabelText('通知邮箱'), 'Finance@ABC-tech.cn');
    await user.click(screen.getByRole('button', { name: '添加' }));
    expect(
      within(screen.getByRole('list', { name: '已添加的通知邮箱' }))
        .getAllByRole('listitem')
        .map((item) => item.firstChild?.textContent),
    ).toEqual(['billing@abc-tech.cn', 'finance@abc-tech.cn']);
    expect(screen.getByLabelText('通知邮箱')).toHaveValue('');
  });
});
