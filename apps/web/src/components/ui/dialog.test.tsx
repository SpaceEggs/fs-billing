import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ModalDialog } from './dialog';

function Harness({ dismissible }: { dismissible: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开</button>
      <ModalDialog
        open={open}
        {...(dismissible ? { onOpenChange: setOpen } : {})}
        title="余额操作"
      >
        <input aria-label="金额" />
      </ModalDialog>
    </>
  );
}

describe('ModalDialog', () => {
  it('closes from the header ×, keeping focus on the first field when opened and returning it to the opener', async () => {
    const user = userEvent.setup();
    render(<Harness dismissible />);
    await user.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog', { name: '余额操作' });
    expect(screen.getByLabelText('金额')).toHaveFocus();

    await user.click(screen.getByRole('button', { name: '关闭对话框' }));
    expect(dialog).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开' })).toHaveFocus();
  });

  it('has no header × when it must not be dismissed', async () => {
    const user = userEvent.setup();
    render(<Harness dismissible={false} />);
    await user.click(screen.getByRole('button', { name: '打开' }));
    expect(screen.getByRole('dialog', { name: '余额操作' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '关闭对话框' }),
    ).not.toBeInTheDocument();
  });
});
