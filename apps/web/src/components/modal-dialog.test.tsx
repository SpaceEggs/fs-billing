import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ModalDialog } from './modal-dialog';

function Harness({
  dismissible,
  plainOnDesktop = false,
}: {
  dismissible: boolean;
  plainOnDesktop?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>打开</button>
      <ModalDialog
        open={open}
        {...(dismissible ? { onOpenChange: setOpen } : {})}
        title="余额操作"
        {...(plainOnDesktop ? { plainOnDesktop } : {})}
      >
        <input aria-label="金额" />
        <button>确定</button>
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

  it('drops the scrim and the header × on desktop when plain, but keeps Esc, the focus trap and the phone ×', async () => {
    const user = userEvent.setup();
    render(<Harness dismissible plainOnDesktop />);
    await user.click(screen.getByRole('button', { name: '打开' }));
    const dialog = screen.getByRole('dialog', { name: '余额操作' });
    // 样式类：电脑上遮罩透明、× 隐藏；手机仍有遮罩与 ×。
    expect(document.querySelector('[data-state="open"].bg-scrim')).toHaveClass(
      'md:bg-transparent',
    );
    expect(screen.getByRole('button', { name: '关闭对话框' })).toHaveClass(
      'md:hidden',
    );
    // 焦点圈定：从最后一个控件继续 Tab 仍在对话框里（× 在 DOM 里，只是电脑上不可见）。
    await user.tab();
    await user.tab();
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    // Esc 关闭，焦点回到打开者。
    await user.keyboard('{Escape}');
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
