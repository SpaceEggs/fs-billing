import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { Field, RecipientsInput } from './form-fields';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('form fields (English)', () => {
  it('renders the recipients input and flags disabled administrators', async () => {
    const { container } = await renderWithLocale(
      'en',
      <RecipientsInput
        emails={['ops@example.com', 'billing@example.com']}
        error={undefined}
        onChange={() => {}}
        flagged={new Set(['ops@example.com'])}
      />,
    );

    expect(screen.getByLabelText('Notification recipients')).toBeVisible();
    expect(
      screen.getByText(
        'Add multiple addresses; low-balance and suspension notices are sent to these addresses',
      ),
    ).toBeVisible();
    const items = within(
      screen.getByRole('list', { name: 'Added Notification recipients' }),
    ).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('ops@example.comDisabled admin');
    expect(items[1]).not.toHaveTextContent('Disabled admin');
    expect(screen.getByRole('status')).toHaveTextContent(
      'ops@example.com belongs to a disabled administrator; confirm the recipient',
    );
    expect(container).not.toHaveTextContent(HAN);
  });

  it('marks an optional field in English', async () => {
    const { container } = await renderWithLocale(
      'en',
      <Field label="Remark" optional error={undefined}>
        {(props) => <input {...props} />}
      </Field>,
    );

    expect(screen.getByText('(optional)')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
