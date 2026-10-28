import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import type { LoginRequest } from '@fs-billing/shared';
import { Label } from '../components/ui/label';
import {
  AdminPill,
  BrandRow,
  LogoMark,
  productLabel,
} from '../components/brand';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { callApi } from '../lib/api';
import { clearBalanceAttempts } from '../lib/balance-attempts';
import {
  loginAlert,
  loginProblem,
  type LoginProblem,
} from '../lib/login-errors';
import { resolveReturnPath, takeReturnPath } from '../lib/return-to';
import {
  sessionExpiry,
  sessionQueryKey,
  type SessionState,
} from '../lib/session';
import { cn } from '../lib/utils';
import type { Zone } from '../lib/zone';

const copy = {
  portal: {
    mobileTitle: '登录客户门户',
    title: '登录',
    subtitle: '使用为你开通的登录邮箱和密码',
    emailPlaceholder: 'name@company.com',
    forgot: '请联系客服重置密码',
  },
  admin: {
    mobileTitle: '登录管理后台',
    title: '登录管理后台',
    subtitle: '仅限内部管理员使用',
    emailPlaceholder: 'name@fs-billing.com',
    forgot: '请联系其他管理员在「管理员」页面为你重置密码',
  },
} as const satisfies Record<Zone, Record<string, string>>;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function ExpiredBanner() {
  return (
    <Alert
      variant="warning"
      role="status"
      className="shrink-0 rounded-none border-x-0 px-5 sm:h-11 sm:flex-row sm:items-center sm:justify-center sm:gap-2 sm:border-t-0 sm:py-0"
    >
      <span className="font-semibold">登录已过期，请重新登录</span>
      <span>登录后将返回之前的页面</span>
    </Alert>
  );
}

function ForgotLink({
  zone,
  onClick,
  className,
}: {
  zone: Zone;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="link"
      size="inline"
      onClick={onClick}
      className={cn(
        zone === 'admin'
          ? 'hover:no-underline'
          : 'text-muted-foreground underline underline-offset-[3px]',
        className,
      )}
    >
      忘记密码？
    </Button>
  );
}

function ForgotHint({ zone, className }: { zone: Zone; className?: string }) {
  return (
    <div
      role="note"
      className={cn(
        'rounded-lg px-2.5 py-2 leading-normal',
        zone === 'admin'
          ? 'border border-brand-border bg-brand-soft'
          : 'bg-muted',
        className,
      )}
    >
      {copy[zone].forgot}
    </div>
  );
}

export function LoginPage({ zone, expired }: { zone: Zone; expired: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const ids = { email: useId(), password: useId() };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [problem, setProblem] = useState<LoginProblem | null>(null);
  const waiting =
    problem?.kind === 'locked' || problem?.kind === 'rate-limited';
  const now = useNow(waiting);
  const alert = loginAlert(zone, problem, now);
  const blocked = alert?.waitLabel !== undefined;

  const waitOver = waiting && !alert;
  useEffect(() => {
    if (waitOver) setProblem(null);
  }, [waitOver]);

  const login = useMutation({
    mutationFn: (request: LoginRequest) => callApi('login', { body: request }),
    onMutate: () => setProblem(null),
    onError: (error) => setProblem(loginProblem(error, Date.now())),
    onSuccess: (session) => {
      queryClient.clear();
      clearBalanceAttempts();
      sessionExpiry.clear();
      const state: SessionState = { status: 'active', session };
      queryClient.setQueryData(sessionQueryKey, state);
      router.history.replace(
        resolveReturnPath(takeReturnPath(), session.identity, router),
      );
    },
  });

  const invalid = problem?.kind === 'invalid-credentials';
  const fieldClass = cn(blocked && 'bg-muted');

  return (
    <div
      className={cn(
        'flex min-h-dvh flex-col bg-background text-foreground sm:bg-page',
        zone === 'admin' && 'sm:border-t-4 sm:border-primary',
      )}
    >
      {expired ? <ExpiredBanner /> : null}
      <main className="flex flex-1 flex-col justify-center gap-6 px-6 pb-16 sm:items-center sm:px-0 sm:pb-0">
        <div className="hidden sm:block">
          <BrandRow zone={zone} />
        </div>
        <div className="flex flex-col items-center gap-3.5 sm:hidden">
          <LogoMark className="size-11 rounded-[10px] text-xl" />
          <div
            className={cn(
              'flex flex-col items-center',
              zone === 'admin' ? 'gap-2' : 'gap-1',
            )}
          >
            <h1 className="m-0 text-[22px] font-semibold">
              {copy[zone].mobileTitle}
            </h1>
            {zone === 'admin' ? (
              <AdminPill>FS-Billing {productLabel.admin}</AdminPill>
            ) : (
              <span className="text-[13px] text-muted-foreground">
                FS-Billing
              </span>
            )}
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!blocked) login.mutate({ email, password });
          }}
          className="flex flex-col gap-6 sm:w-[400px] sm:gap-5 sm:rounded-xl sm:border sm:border-border sm:bg-card sm:p-8 sm:shadow-[0_1px_3px_rgba(0,0,0,.04)]"
        >
          <div className="hidden flex-col gap-1.5 sm:flex">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
              {copy[zone].title}
            </h1>
            <span className="text-[13px] text-muted-foreground">
              {copy[zone].subtitle}
            </span>
          </div>
          {alert ? (
            <Alert
              variant={alert.tone === 'warn' ? 'warning' : 'destructive'}
              role="alert"
            >
              {alert.tone === 'warn' ? (
                <TriangleAlertIcon aria-hidden />
              ) : (
                <CircleAlertIcon aria-hidden />
              )}
              <AlertTitle>{alert.title}</AlertTitle>
              <AlertDescription>{alert.body}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-3.5">
            <div className="flex flex-col gap-1.5 text-sm font-medium sm:text-[13px]">
              <Label htmlFor={ids.email}>登录邮箱</Label>
              <Input
                id={ids.email}
                type="email"
                name="email"
                autoComplete="username"
                required
                disabled={blocked}
                placeholder={copy[zone].emailPlaceholder}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={cn('font-normal', fieldClass)}
              />
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-medium sm:text-[13px]">
              <div className="flex items-center justify-between">
                <Label htmlFor={ids.password}>密码</Label>
                <ForgotLink
                  zone={zone}
                  onClick={() => setForgotOpen((open) => !open)}
                  className="hidden text-xs font-normal sm:inline"
                />
              </div>
              <div
                className={cn(
                  'flex h-11 items-center rounded-lg border border-input font-normal focus-within:ring-[3px] focus-within:ring-ring/50 sm:h-10 sm:pr-1',
                  invalid &&
                    'border-neg shadow-[0_0_0_3px_var(--alert-neg-bg)] focus-within:ring-0',
                  fieldClass,
                )}
              >
                <Input
                  id={ids.password}
                  type={showPassword ? 'text' : 'password'}
                  name="password"
                  autoComplete="current-password"
                  required
                  disabled={blocked}
                  placeholder="请输入密码"
                  aria-invalid={invalid || undefined}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent pr-0 pl-3 focus-visible:ring-0 sm:h-full"
                />
                <Button
                  variant="ghost"
                  size="inline"
                  aria-label={showPassword ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((shown) => !shown)}
                  className="h-11 w-14 shrink-0 text-[13px] text-muted-foreground hover:bg-transparent sm:h-8 sm:w-auto sm:rounded-md sm:px-2.5 sm:text-xs"
                >
                  {showPassword ? '隐藏' : '显示'}
                </Button>
              </div>
              {forgotOpen ? (
                <ForgotHint
                  zone={zone}
                  className="hidden text-xs font-normal text-foreground sm:block"
                />
              ) : null}
            </div>
          </div>
          <Button
            type="submit"
            size="field"
            disabled={blocked || login.isPending}
          >
            {alert?.waitLabel ?? '登录'}
          </Button>
          <div className="flex flex-col items-center gap-2 sm:hidden">
            <ForgotLink
              zone={zone}
              onClick={() => setForgotOpen((open) => !open)}
              className="flex h-11 items-center text-sm"
            />
            {forgotOpen ? (
              <ForgotHint
                zone={zone}
                className="px-3 text-center text-[13px]"
              />
            ) : null}
          </div>
        </form>
        {zone === 'admin' ? (
          <span className="hidden text-xs text-muted-foreground sm:block">
            客户请使用客户门户登录
          </span>
        ) : null}
      </main>
    </div>
  );
}
