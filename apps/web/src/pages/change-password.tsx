import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { BrandRow } from '../components/brand';
import { SessionExpiredDialog } from '../components/session-expired-dialog';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { useCredentialMutation } from '../lib/admin-api';
import { ApiRequestError } from '../lib/api';
import { formatDuration } from '../lib/duration';
import { resolveReturnPath, takeReturnPath } from '../lib/return-to';
import {
  passwordGate,
  sessionQueryKey,
  type SessionState,
} from '../lib/session';
import { logoutFailedMessage, useLogout } from '../lib/use-logout';
import { cn } from '../lib/utils';
import { zones, type Zone } from '../lib/zone';

type Field = 'current' | 'next' | 'confirm';
type Problem =
  | { kind: 'fields'; errors: Partial<Record<Field, string>> }
  | { kind: 'wait'; seconds: number }
  | { kind: 'unavailable' };

/** 本地先检查长度与两次输入一致，再由服务端核对当前密码。 */
export function checkNewPassword(values: Record<Field, string>) {
  const errors: Partial<Record<Field, string>> = {};
  if (!values.current) errors.current = '请输入当前密码';
  if (values.next.length < 8) errors.next = '新密码至少 8 位';
  else if (values.next.length > 128) errors.next = '新密码最多 128 位';
  if (!errors.next && values.confirm !== values.next)
    errors.confirm = '两次输入的新密码不一致';
  return errors;
}

function serverProblem(error: unknown): Problem | null {
  if (!(error instanceof ApiRequestError) || !error.body)
    return { kind: 'unavailable' };
  const detail = error.body.error;
  switch (detail.code) {
    case 'INVALID_CREDENTIALS':
      return { kind: 'fields', errors: { current: '当前密码不正确' } };
    case 'VALIDATION_ERROR':
      return { kind: 'fields', errors: { next: '新密码至少 8 位' } };
    case 'ACCOUNT_LOCKED':
    case 'RATE_LIMITED':
      return { kind: 'wait', seconds: detail.retryAfterSeconds };
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
      // 登录过期对话框接管。
      return null;
    default:
      return { kind: 'unavailable' };
  }
}

function PasswordInput({
  id,
  label,
  hint,
  error,
  value,
  autoComplete,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string | undefined;
  error: string | undefined;
  value: string;
  autoComplete: string;
  onChange: (value: string) => void;
}) {
  const [shown, setShown] = useState(false);
  const message = error ?? hint;
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium sm:text-[13px]">
      <Label htmlFor={id}>{label}</Label>
      <div
        className={cn(
          'flex h-11 items-center rounded-lg border border-input font-normal focus-within:ring-[3px] focus-within:ring-ring/50 sm:h-10 sm:pr-1',
          error &&
            'border-neg shadow-[0_0_0_3px_var(--alert-neg-bg)] focus-within:ring-0',
        )}
      >
        <Input
          id={id}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? `${id}-message` : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent pr-0 pl-3 focus-visible:ring-0 sm:h-full"
        />
        <Button
          variant="ghost"
          size="inline"
          aria-label={shown ? `隐藏${label}` : `显示${label}`}
          aria-pressed={shown}
          onClick={() => setShown((value) => !value)}
          className="h-11 w-14 shrink-0 text-[13px] text-muted-foreground hover:bg-transparent sm:h-8 sm:w-auto sm:rounded-md sm:px-2.5 sm:text-xs"
        >
          {shown ? '隐藏' : '显示'}
        </Button>
      </div>
      {message ? (
        <span
          id={`${id}-message`}
          className={cn(
            'text-xs font-normal',
            error ? 'text-neg' : 'text-muted-foreground',
          )}
        >
          {message}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 修改密码表单，强制改密页与账号设置页共用（同一个 changePassword：撤销其他会话并签发新会话）。
 * `forced` 时成功后回到进入前的页面，否则留在原页并显示成功提示。
 */
export function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = { current: useId(), next: useId(), confirm: useId() };
  const empty: Record<Field, string> = { current: '', next: '', confirm: '' };
  const [values, setValues] = useState(empty);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [changed, setChanged] = useState(false);

  // 当前密码（可能是临时密码）与新密码不进 MutationCache。
  const change = useCredentialMutation('changePassword');
  async function submit(currentPassword: string, newPassword: string) {
    setProblem(null);
    setChanged(false);
    let session;
    try {
      session = await change.submit({
        body: { currentPassword, newPassword },
      });
    } catch (error) {
      setProblem(serverProblem(error));
      return;
    }
    if (!session) return;
    passwordGate.clear();
    const state: SessionState = { status: 'active', session };
    queryClient.setQueryData(sessionQueryKey, state);
    if (forced) {
      router.history.replace(
        resolveReturnPath(takeReturnPath(), session.identity, router),
      );
      return;
    }
    setValues(empty);
    setChanged(true);
  }

  const errors = problem?.kind === 'fields' ? problem.errors : {};
  const set = (field: Field) => (value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  return (
    <form
      aria-label="修改密码"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const local = checkNewPassword(values);
        if (Object.keys(local).length) {
          setProblem({ kind: 'fields', errors: local });
          return;
        }
        void submit(values.current, values.next);
      }}
      className="flex flex-col gap-5"
    >
      {changed ? (
        <Alert variant="success">
          <CircleCheckIcon aria-hidden />
          <AlertTitle>密码已修改</AlertTitle>
          <AlertDescription>其他设备上的登录将失效</AlertDescription>
        </Alert>
      ) : null}
      {problem?.kind === 'wait' ? (
        <Alert variant="warning" role="alert">
          <TriangleAlertIcon aria-hidden />
          <AlertTitle>尝试次数过多，已暂时锁定</AlertTitle>
          <AlertDescription>
            {`请在 ${formatDuration(problem.seconds)} 后重试`}
          </AlertDescription>
        </Alert>
      ) : null}
      {problem?.kind === 'unavailable' ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden />
          <AlertTitle>暂时无法修改密码</AlertTitle>
          <AlertDescription>服务暂时不可用，请稍后重试</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-3.5">
        <PasswordInput
          id={ids.current}
          label="当前密码"
          hint={forced ? '管理员提供的临时密码' : undefined}
          error={errors.current}
          value={values.current}
          autoComplete="current-password"
          onChange={set('current')}
        />
        <PasswordInput
          id={ids.next}
          label="新密码"
          hint="至少 8 位"
          error={errors.next}
          value={values.next}
          autoComplete="new-password"
          onChange={set('next')}
        />
        <PasswordInput
          id={ids.confirm}
          label="确认新密码"
          error={errors.confirm}
          value={values.confirm}
          autoComplete="new-password"
          onChange={set('confirm')}
        />
      </div>
      <Button
        type="submit"
        size="field"
        disabled={change.isPending}
        className={forced ? undefined : 'sm:h-9 sm:self-start'}
      >
        修改密码
      </Button>
    </form>
  );
}

/**
 * 强制改密页。`forced` 时为首次登录或重置后的强制改密：
 * 只能改密或退出，其他业务请求都会被服务端以 PASSWORD_CHANGE_REQUIRED 拒绝。
 */
export function ChangePasswordPage({
  zone,
  forced,
}: {
  zone: Zone;
  forced: boolean;
}) {
  const logout = useLogout(zone);
  return (
    <div
      className={cn(
        'flex min-h-dvh flex-col bg-background text-foreground sm:bg-page',
        zone === 'admin' && 'sm:border-t-4 sm:border-primary',
      )}
    >
      <main className="flex flex-1 flex-col justify-center gap-6 px-6 py-10 sm:items-center sm:px-0">
        <BrandRow zone={zone} />
        <div className="flex flex-col gap-5 sm:w-[400px] sm:rounded-xl sm:border sm:border-border sm:bg-card sm:p-8 sm:shadow-[0_1px_3px_rgba(0,0,0,.04)]">
          <div className="flex flex-col gap-1.5">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
              {forced ? '请修改初始密码' : '修改密码'}
            </h1>
            <span className="text-[13px] leading-normal text-muted-foreground">
              {forced
                ? '首次登录或密码被重置后，需要设置新密码才能继续使用。修改后，其他设备上的登录将失效'
                : '修改后，其他设备上的登录将失效'}
            </span>
          </div>
          <ChangePasswordForm forced={forced} />
          <div className="flex items-center justify-center gap-4 text-sm">
            {forced ? null : (
              <Link to={zones[zone].home} className="text-muted-foreground">
                返回
              </Link>
            )}
            <Button
              variant="ghost"
              size="inline"
              className="text-neg hover:bg-transparent"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              退出登录
            </Button>
          </div>
          {logout.isError ? (
            <p role="alert" className="m-0 text-center text-sm text-neg">
              {logoutFailedMessage}
            </p>
          ) : null}
        </div>
      </main>
      <SessionExpiredDialog zone={zone} />
    </div>
  );
}
