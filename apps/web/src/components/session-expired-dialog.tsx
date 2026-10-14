import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { rememberReturnPath } from '../lib/return-to';
import { sessionExpiry, useSessionExpired } from '../lib/session';
import { zones, type Zone } from '../lib/zone';
import { Button } from './ui/button';

/** 页面内请求收到 401 reauthenticate 时弹出（第三批 3c/3d）；不可关闭，只能重新登录。 */
export function SessionExpiredDialog({ zone }: { zone: Zone }) {
  const expired = useSessionExpired();
  const router = useRouter();
  const queryClient = useQueryClient();

  async function reauthenticate() {
    rememberReturnPath(router.state.location.href);
    sessionExpiry.clear();
    queryClient.clear();
    await router.navigate({
      to: zones[zone].login,
      search: { reason: 'expired' },
    });
  }

  return (
    <Dialog.Root open={expired}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          className="fixed inset-x-0 bottom-0 z-50 flex flex-col gap-4 rounded-t-2xl bg-card px-5 pt-2 pb-7 text-foreground outline-none md:inset-auto md:top-1/2 md:left-1/2 md:w-[420px] md:-translate-x-1/2 md:-translate-y-1/2 md:gap-5 md:rounded-xl md:border md:border-border md:p-6 md:shadow-[0_20px_50px_rgba(0,0,0,.25)]"
        >
          <div
            aria-hidden
            className="h-1 w-9 self-center rounded-sm bg-input md:hidden"
          />
          <div className="flex flex-col gap-2">
            <Dialog.Title className="m-0 text-[17px] font-semibold">
              登录已过期，请重新登录
            </Dialog.Title>
            <Dialog.Description className="m-0 text-sm leading-relaxed text-muted-foreground">
              为保障账户安全，长时间未操作后需要重新登录。登录后将回到当前页面。
            </Dialog.Description>
          </div>
          <div className="flex md:justify-end">
            <Button
              className="h-11 w-full text-base md:h-9 md:w-auto md:text-sm"
              onClick={() => void reauthenticate()}
            >
              重新登录
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
