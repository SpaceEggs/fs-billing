import { Button } from '../components/ui/button';
import { loginAlert } from '../lib/login-errors';
import { logoutFailedMessage, useLogout } from '../lib/use-logout';
import type { Zone } from '../lib/zone';

/** 资料停用或身份无法使用：不自动重登，只提供退出（API 设计 §3）。 */
export function BlockedPage({
  zone,
  code,
}: {
  zone: Zone;
  code: 'ACCOUNT_DISABLED' | 'IDENTITY_UNAVAILABLE';
}) {
  const logout = useLogout(zone);
  const alert = loginAlert(
    zone,
    {
      kind:
        code === 'ACCOUNT_DISABLED'
          ? 'account-disabled'
          : 'identity-unavailable',
    },
    Date.now(),
  );
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
      <h1 className="m-0 text-lg font-semibold">{alert?.title}</h1>
      <p className="m-0 text-sm text-muted-foreground">{alert?.body}</p>
      <Button
        variant="danger"
        className="mt-2"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
      >
        退出登录
      </Button>
      {logout.isError ? (
        <p role="alert" className="m-0 text-sm text-neg">
          {logoutFailedMessage}
        </p>
      ) : null}
    </div>
  );
}
