import { Card } from '@/components/ui/card';
import { useEffect, useId, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react';
import { translate, type LoginRequest } from '@fs-billing/shared';
import { Label } from '../components/ui/label';
import { useLocale } from '../i18n';
import { AdminPill, BrandRow, LogoMark } from '../components/brand';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { LocaleMenu } from '../components/locale-menu';
import { callApi } from '../lib/api';
import { clearBalanceAttempts } from '../lib/balance-attempts';
import {
  loginAlert,
  loginProblem,
  type LoginProblem,
} from '../lib/login-errors';
import { resolveReturnPath, takeReturnPath } from '../lib/return-to';
import {
  resetAccountLocaleSync,
  sessionExpiry,
  sessionQueryKey,
  syncAccountLocale,
  type SessionState,
} from '../lib/session';
import { cn } from '../lib/utils';
import type { Zone } from '../lib/zone';

const copy = {
  portal: {
    mobileTitle: 'auth:login.mobileTitle.portal',
    title: 'auth:login.title.portal',
    subtitle: 'auth:login.subtitle.portal',
    emailPlaceholder: 'auth:login.emailPlaceholder.portal',
    forgot: 'auth:login.forgotHint.portal',
  },
  admin: {
    mobileTitle: 'auth:login.mobileTitle.admin',
    title: 'auth:login.title.admin',
    subtitle: 'auth:login.subtitle.admin',
    emailPlaceholder: 'auth:login.emailPlaceholder.admin',
    forgot: 'auth:login.forgotHint.admin',
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
  const locale = useLocale();
  return (
    <Alert
      variant="warning"
      role="status"
      className="shrink-0 rounded-none border-x-0 px-5 sm:h-11 sm:flex-row sm:items-center sm:justify-center sm:gap-2 sm:border-t-0 sm:py-0"
    >
      <span className="font-semibold">
        {translate(locale, 'auth:login.expired.title')}
      </span>
      <span>{translate(locale, 'auth:login.expired.body')}</span>
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
  const locale = useLocale();
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
      {translate(locale, 'auth:login.forgot')}
    </Button>
  );
}

function ForgotHint({ zone, className }: { zone: Zone; className?: string }) {
  const locale = useLocale();
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
      {translate(locale, copy[zone].forgot)}
    </div>
  );
}

export function LoginPage({ zone, expired }: { zone: Zone; expired: boolean }) {
  const locale = useLocale();
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
      resetAccountLocaleSync();
      void syncAccountLocale(session);
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
      <main className="relative flex flex-1 flex-col justify-center gap-6 px-6 pb-16 sm:items-center sm:px-0 sm:pb-0">
        <div className="absolute top-4 right-4 z-10">
          <LocaleMenu />
        </div>
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
              {translate(locale, copy[zone].mobileTitle)}
            </h1>
            {zone === 'admin' ? (
              <AdminPill>
                FS-Billing {translate(locale, 'shell:product.admin')}
              </AdminPill>
            ) : (
              <span className="text-[13px] text-muted-foreground">
                FS-Billing
              </span>
            )}
          </div>
        </div>
        <Card
          asChild
          className="rounded-none border-0 bg-transparent py-0 text-inherit shadow-none flex flex-col gap-6 sm:w-[400px] sm:gap-5 sm:rounded-xl sm:border sm:border-border sm:bg-card sm:p-8 sm:shadow-[0_1px_3px_rgba(0,0,0,.04)]"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!blocked) login.mutate({ email, password });
            }}
          >
            <div className="hidden flex-col gap-1.5 sm:flex">
              <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
                {translate(locale, copy[zone].title)}
              </h1>
              <span className="text-[13px] text-muted-foreground">
                {translate(locale, copy[zone].subtitle)}
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
                <Label htmlFor={ids.email}>
                  {translate(locale, 'auth:login.email')}
                </Label>
                <Input
                  id={ids.email}
                  type="email"
                  name="email"
                  autoComplete="username"
                  required
                  disabled={blocked}
                  placeholder={translate(locale, copy[zone].emailPlaceholder)}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className={cn('font-normal', fieldClass)}
                />
              </div>
              <div className="flex flex-col gap-1.5 text-sm font-medium sm:text-[13px]">
                <div className="flex items-center justify-between">
                  <Label htmlFor={ids.password}>
                    {translate(locale, 'auth:login.password')}
                  </Label>
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
                    placeholder={translate(
                      locale,
                      'auth:login.passwordPlaceholder',
                    )}
                    aria-invalid={invalid || undefined}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    className="h-full min-w-0 flex-1 rounded-none border-0 bg-transparent pr-0 pl-3 focus-visible:ring-0 sm:h-full"
                  />
                  <Button
                    variant="ghost"
                    size="inline"
                    aria-label={translate(
                      locale,
                      showPassword
                        ? 'auth:login.hidePassword'
                        : 'auth:login.showPassword',
                    )}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((shown) => !shown)}
                    className="h-11 w-14 shrink-0 text-[13px] text-muted-foreground hover:bg-transparent sm:h-8 sm:w-auto sm:rounded-md sm:px-2.5 sm:text-xs"
                  >
                    {translate(
                      locale,
                      showPassword ? 'auth:login.hide' : 'auth:login.show',
                    )}
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
              {alert?.waitLabel ?? translate(locale, 'auth:login.submit')}
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
        </Card>
        {zone === 'admin' ? (
          <span className="hidden text-xs text-muted-foreground sm:block">
            {translate(locale, 'auth:login.adminFooter')}
          </span>
        ) : null}
      </main>
    </div>
  );
}
