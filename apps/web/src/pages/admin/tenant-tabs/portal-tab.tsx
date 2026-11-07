import { Card } from '@/components/ui/card';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminPortalAccount,
  AdminPortalAccountCreateResponse,
  AdminStatus,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Badge } from '../../../components/ui/badge';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import {
  AccountStatusDialog,
  ResetPasswordDialog,
  StatusChangeNotice,
  TemporaryPassword,
  refreshAccounts,
  type AccountTarget,
  type StatusChange,
} from '../../../components/admin/account-dialogs';
import { Field, invalidClass } from '../../../components/admin/form-fields';
import { ProblemAlert } from '../../../components/admin/problem-alert';
import { DateTime } from '../../../components/data-format';
import { QueryError } from '../../../components/query-error';
import { Button } from '../../../components/ui/button';
import { ModalDialog } from '../../../components/modal-dialog';
import { Input } from '../../../components/ui/input';
import { apiQuery, useCredentialMutation } from '../../../lib/admin-api';
import {
  buildPortalCreate,
  outcomeUnknown,
  serverAccountErrors,
  type AccountFieldErrors,
} from '../../../lib/accounts';
import { apiProblem } from '../../../lib/api-problem';
import { cn } from '../../../lib/utils';

const accountStatusVariant = {
  active: 'ok',
  disabled: 'off',
} as const satisfies Record<AdminStatus, string>;

const fieldRow =
  'flex flex-col gap-0.5 border-b border-border py-3 last:border-b-0 md:grid md:grid-cols-[140px_1fr] md:items-center md:gap-0';
const fieldLabel = 'text-xs text-muted-foreground md:text-sm';

type Action = 'create' | 'reset' | 'disable' | 'enable';

const toTarget = (account: AdminPortalAccount): AccountTarget => ({
  audience: 'portal',
  id: account.id,
  name: account.email,
  email: account.email,
});

/**
 * 补开门户账号（开户时门户账号创建失败的租户）。初始密码可留空由系统生成，生成的临时密码只显示一次。
 * 创建没有可重放的响应，不自动重试；结果未知时引导先刷新核实，已开通则用重置密码。
 */
export function CreatePortalDialog({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['tenant', 'admin', 'common']);
  const queryClient = useQueryClient();
  const create = useCredentialMutation('adminPortalAccountCreate');
  const [form, setForm] = useState({ email: '', initialPassword: '' });
  const [errors, setErrors] = useState<AccountFieldErrors>({});
  const [created, setCreated] =
    useState<AdminPortalAccountCreateResponse | null>(null);

  const unknown = create.error ? outcomeUnknown(create.error) : false;
  const problem = create.error && !unknown ? apiProblem(create.error) : null;
  const emailTaken =
    problem?.kind === 'conflict' && problem.code === 'EMAIL_EXISTS'
      ? problem.message
      : undefined;
  const shown: AccountFieldErrors = {
    ...errors,
    ...serverAccountErrors(problem),
    ...(emailTaken ? { email: emailTaken } : {}),
  };
  const refresh = () => refreshAccounts(queryClient, 'portal');

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const built = buildPortalCreate(form);
    if (!built.ok) {
      create.reset();
      setErrors(built.errors);
      return;
    }
    setErrors({});
    try {
      const response = await create.submit({
        params: { tenantId },
        body: built.request,
      });
      if (response) {
        setForm({ email: '', initialPassword: '' });
        setCreated(response);
      }
      void refresh();
    } catch (error) {
      if (outcomeUnknown(error)) void refresh();
    }
  }

  if (created)
    return (
      <ModalDialog
        open
        title={t('tenant:portal.createdTitle')}
        description={created.account.email}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">
            {t('tenant:portal.createdTitle')}
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {created.account.email}
          </span>
        </div>
        {created.passwordSource === 'generated' ? (
          <TemporaryPassword
            value={created.temporaryPassword}
            recipient={t('admin:accountDialogs.portalRecipient')}
            logged={t('tenant:portal.createdLogged')}
          />
        ) : (
          <p className="m-0 text-[13px] text-muted-foreground">
            {t('tenant:portal.initialPasswordUsed')}
          </p>
        )}
        <div className="flex flex-col md:flex-row md:justify-end">
          <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
            {created.passwordSource === 'generated'
              ? t('admin:accountDialogs.copiedClose')
              : t('common:ui.close')}
          </Button>
        </div>
      </ModalDialog>
    );

  return (
    <ModalDialog
      open
      {...(create.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={t('tenant:portal.createTitle')}
      description={t('tenant:portal.createDescription')}
      className="md:w-[480px]"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">
          {t('tenant:portal.createTitle')}
        </h2>
        <span className="text-[13px] text-muted-foreground">
          {t('tenant:portal.createDescription')}
        </span>
      </div>
      <form
        aria-label={t('tenant:portal.createTitle')}
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Field
          label={t('tenant:create.portalEmail')}
          required
          error={shown.email}
        >
          {(props) => (
            <Input
              {...props}
              type="email"
              autoComplete="off"
              placeholder="name@company.com"
              value={form.email}
              onChange={(event) =>
                setForm({ ...form, email: event.target.value })
              }
              className={invalidClass(shown.email)}
            />
          )}
        </Field>
        <Field
          label={t('tenant:create.initialPassword')}
          optional
          error={shown.initialPassword}
          hint={t('tenant:create.passwordHint')}
        >
          {(props) => (
            <Input
              {...props}
              type="password"
              autoComplete="new-password"
              placeholder={t('tenant:create.passwordPlaceholder')}
              value={form.initialPassword}
              onChange={(event) =>
                setForm({ ...form, initialPassword: event.target.value })
              }
              className={cn('font-mono', invalidClass(shown.initialPassword))}
            />
          )}
        </Field>
        {unknown ? (
          <Alert variant="error">
            <span className="font-semibold">
              {t('tenant:portal.unknownTitle')}
            </span>
            <span>{t('tenant:portal.unknownBody')}</span>
          </Alert>
        ) : create.error && !emailTaken ? (
          <ProblemAlert
            error={create.error}
            onRefresh={() => {
              void refresh();
              onClose();
            }}
          />
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={create.isPending}
            onClick={onClose}
          >
            {t('common:action.cancel')}
          </Button>
          <Button
            type="submit"
            className="h-12 md:h-9"
            disabled={create.isPending}
          >
            {create.isPending
              ? t('tenant:portal.creating')
              : t('tenant:portal.create')}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** 门户账号（设计稿第三批租户详情 1j/1k、2d/2e）：第一版每个租户一个账号。 */
export function PortalTab({
  tenantId,
  tenantDisabled,
}: {
  tenantId: string;
  tenantDisabled: boolean;
}) {
  const { t } = useTranslation(['tenant', 'admin', 'common']);
  const accounts = useQuery(
    apiQuery('adminPortalAccounts', { params: { tenantId } }),
  );
  const [action, setAction] = useState<Action | null>(null);
  const [change, setChange] = useState<StatusChange | null>(null);
  const open = (next: Action) => {
    setChange(null);
    setAction(next);
  };
  const close = () => setAction(null);
  if (accounts.isError)
    return (
      <QueryError
        title={t('tenant:portal.loadFailed')}
        error={accounts.error}
        retrying={accounts.isFetching}
        onRetry={() => void accounts.refetch()}
      />
    );
  if (!accounts.data)
    return (
      <Skeleton
        aria-busy
        aria-label={t('tenant:portal.loading')}
        className="h-[180px] max-w-[760px] rounded-xl"
      />
    );
  const account = accounts.data.items[0];
  const toggle = account?.status === 'disabled' ? 'enable' : 'disable';
  const actions = account ? (
    <>
      <Button
        variant="outline"
        className="h-11 md:h-9"
        onClick={() => open('reset')}
      >
        {t('admin:accountDialogs.resetPassword')}
      </Button>
      <Button
        variant="outline"
        className={cn(
          'h-11 md:h-9',
          toggle === 'disable'
            ? 'border-err-border text-neg'
            : 'border-brand-border text-primary',
        )}
        onClick={() => open(toggle)}
      >
        {toggle === 'disable'
          ? t('admin:accountDialogs.status.portal.disable.confirm')
          : t('admin:accountDialogs.status.portal.enable.confirm')}
      </Button>
    </>
  ) : null;
  return (
    <div className="flex max-w-[760px] flex-col gap-3.5">
      {change ? <StatusChangeNotice change={change} /> : null}
      {tenantDisabled ? (
        <Alert variant="muted" role="note" className="px-3.5">
          <AlertDescription>
            <span className="font-semibold">
              {t('tenant:portal.tenantDisabledTitle')}
            </span>
            {t('tenant:portal.tenantDisabledBody')}
          </AlertDescription>
        </Alert>
      ) : null}
      {account?.status === 'disabled' ? (
        <Alert variant="muted" role="note" className="px-3.5">
          <AlertDescription>
            <span className="font-semibold">
              {t('tenant:portal.accountDisabledTitle')}
            </span>
            {t('tenant:portal.accountDisabledBody')}
          </AlertDescription>
        </Alert>
      ) : null}
      <Card
        asChild
        className={cn(
          'block gap-0 bg-transparent py-0 text-inherit shadow-none',
          'rounded-xl border border-border',
        )}
      >
        <section aria-label={t('tenant:portal.sectionAria')}>
          <div className="hidden items-center justify-between gap-3 border-b border-border px-5 py-4 md:flex">
            <div className="flex flex-col gap-1">
              <span className="text-[15px] font-semibold">
                {t('tenant:portal.sectionTitle')}
              </span>
              <span className="text-xs text-muted-foreground">
                {t('tenant:portal.subtitle')}
              </span>
            </div>
            {actions ? <div className="flex gap-2">{actions}</div> : null}
          </div>
          {account ? (
            // 手机（第三批 3j）标签在上、值在下，状态标签靠右；电脑为两列。
            <dl className="m-0 px-3.5 py-1 text-sm tabular-nums md:px-5 md:pt-1 md:pb-2">
              <div className={fieldRow}>
                <dt className={fieldLabel}>{t('tenant:portal.email')}</dt>
                <dd className="m-0 break-all">{account.email}</dd>
              </div>
              <div
                className={cn(
                  fieldRow,
                  'flex-row items-center justify-between',
                )}
              >
                <dt className={fieldLabel}>{t('tenant:portal.status')}</dt>
                <dd className="m-0">
                  <Badge variant={accountStatusVariant[account.status]}>
                    {account.status === 'disabled'
                      ? t('tenant:portal.accountStatusDisabled')
                      : t('tenant:portal.accountStatusEnabled')}
                  </Badge>
                </dd>
              </div>
              <div className={fieldRow}>
                <dt className={fieldLabel}>{t('tenant:portal.lastLogin')}</dt>
                <dd className="m-0">
                  {account.lastLoginAt ? (
                    <DateTime value={account.lastLoginAt} />
                  ) : (
                    <span className="text-muted-foreground">
                      {t('tenant:portal.never')}
                    </span>
                  )}
                </dd>
              </div>
              <div className={fieldRow}>
                <dt className={fieldLabel}>{t('tenant:portal.createdAt')}</dt>
                <dd className="m-0">
                  <DateTime value={account.createdAt} />
                </dd>
              </div>
            </dl>
          ) : (
            <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
              <span className="text-[15px] font-semibold">
                {t('tenant:portal.emptyTitle')}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {t('tenant:portal.emptyBody')}
              </span>
              <Button className="mt-2" onClick={() => open('create')}>
                {t('tenant:portal.open')}
              </Button>
            </div>
          )}
        </section>
      </Card>
      <span className="text-xs text-muted-foreground md:hidden">
        {t('tenant:portal.subtitle')}
      </span>
      {actions ? (
        <div className="flex flex-col gap-2 md:hidden">{actions}</div>
      ) : null}
      {action === 'create' ? (
        <CreatePortalDialog tenantId={tenantId} onClose={close} />
      ) : null}
      {account && action === 'reset' ? (
        <ResetPasswordDialog
          key={account.id}
          target={toTarget(account)}
          onClose={close}
        />
      ) : null}
      {account && (action === 'disable' || action === 'enable') ? (
        <AccountStatusDialog
          key={account.id}
          target={toTarget(account)}
          action={action}
          extraNote={
            action === 'enable' && tenantDisabled
              ? t('tenant:portal.tenantDisabledEnableNote')
              : undefined
          }
          onClose={close}
          onDone={(done) => {
            close();
            setChange(done);
          }}
        />
      ) : null}
    </div>
  );
}
