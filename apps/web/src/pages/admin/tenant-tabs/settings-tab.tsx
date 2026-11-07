import { Card } from '@/components/ui/card';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminAccountsResponse,
  AdminTenantDetailResponse,
} from '@fs-billing/shared';
import { Alert } from '../../../components/ui/alert';
import {
  Field,
  MoneyInput,
  RecipientsInput,
} from '../../../components/admin/form-fields';
import { ProblemAlert } from '../../../components/admin/problem-alert';
import { Button } from '../../../components/ui/button';
import { ModalDialog } from '../../../components/modal-dialog';
import {
  apiKey,
  invalidateTenant,
  useApiMutation,
} from '../../../lib/admin-api';
import {
  normalizeAmountInput,
  settingsAmountError,
} from '../../../lib/amounts';
import { callApi } from '../../../lib/api';
import { apiProblem } from '../../../lib/api-problem';
import { formatMoney } from '../../../lib/format';
import {
  hasSettingsChanges,
  serverSettingsErrors,
  settingsChanges,
  settingsForm,
  validateSettings,
  type SettingsChanges,
  type SettingsErrors,
  type SettingsForm,
  type SettingsRequest,
} from '../../../lib/tenant-settings';
import { useLocale } from '../../../i18n';
import { cn } from '../../../lib/utils';

/**
 * 已停用管理员的邮箱（决定“收件人补充”）：设置页加载和保存后标记，不自动移除。
 * 管理员列表每页最多 100 个，逐页取完。
 */
function useDisabledAdminEmails() {
  return useQuery({
    queryKey: [...apiKey('adminAccounts'), 'disabled-emails'],
    queryFn: async () => {
      const emails = new Set<string>();
      for (let page = 1; ; page += 1) {
        const result: AdminAccountsResponse = await callApi('adminAccounts', {
          query: { status: 'disabled', page, pageSize: 100 },
        });
        for (const account of result.items)
          emails.add(account.email.toLowerCase());
        if (page * result.pagination.pageSize >= result.pagination.total)
          return emails;
      }
    },
  });
}

type Saved = { changed: boolean };

function ChangeSummary({
  tenant,
  changes,
}: {
  tenant: AdminTenantDetailResponse;
  changes: SettingsChanges;
}) {
  const { t } = useTranslation(['tenant']);
  const money = (amount: string) =>
    formatMoney({ currency: tenant.currency, amount });
  const separator = t('tenant:settings.listSeparator');
  const rows: [string, string][] = [];
  if (changes.overdraftLimit)
    rows.push([
      t('tenant:settings.changeOverdraft'),
      `${money(changes.overdraftLimit.before)} → ${money(changes.overdraftLimit.after)}`,
    ]);
  if (changes.availableBalance)
    rows.push([
      t('tenant:settings.changeAvailable'),
      `${money(changes.availableBalance.before)} → ${money(changes.availableBalance.after)}`,
    ]);
  if (changes.lowBalanceThreshold)
    rows.push([
      t('tenant:settings.changeThreshold'),
      `${money(changes.lowBalanceThreshold.before)} → ${money(changes.lowBalanceThreshold.after)}`,
    ]);
  if (changes.emailsAdded.length)
    rows.push([
      t('tenant:settings.changeEmailsAdded'),
      changes.emailsAdded.join(separator),
    ]);
  if (changes.emailsRemoved.length)
    rows.push([
      t('tenant:settings.changeEmailsRemoved'),
      changes.emailsRemoved.join(separator),
    ]);
  return (
    <dl className="m-0 grid grid-cols-[104px_1fr] border-t border-border text-sm tabular-nums">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="border-b border-border py-2.5 text-muted-foreground">
            {label}
          </dt>
          <dd className="m-0 border-b border-border py-2.5 break-all">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 设置（设计稿第三批 1h/1i、2c）：透支额度、提醒阈值与通知邮箱，保存前显示变更摘要。 */
export function SettingsTab({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const [saved, setSaved] = useState<Saved | null>(null);
  // 保存成功后详情重新加载，按新快照重置表单。
  const snapshot = JSON.stringify([tenant.overdraftLimit, tenant.settings]);
  return (
    <SettingsEditor
      key={snapshot}
      tenant={tenant}
      saved={saved}
      onSaved={setSaved}
    />
  );
}

function SettingsEditor({
  tenant,
  saved,
  onSaved,
}: {
  tenant: AdminTenantDetailResponse;
  saved: Saved | null;
  onSaved: (saved: Saved | null) => void;
}) {
  const { t } = useTranslation(['tenant', 'common', 'admin']);
  const locale = useLocale();
  const queryClient = useQueryClient();
  const loaded = settingsForm(tenant);
  const [form, setForm] = useState<SettingsForm>(loaded);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [pending, setPending] = useState<{
    request: SettingsRequest;
    changes: SettingsChanges;
  } | null>(null);
  const disabledAdmins = useDisabledAdminEmails();
  const save = useApiMutation('adminTenantSettings', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });

  const dirty = JSON.stringify(form) !== JSON.stringify(loaded);
  const errorCount = Object.keys(errors).length;
  const update = (patch: Partial<SettingsForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    setErrors({});
    onSaved(null);
  };

  function review() {
    const result = validateSettings(form, locale);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    const changes = settingsChanges(tenant, result.value);
    if (!hasSettingsChanges(changes)) {
      setForm(loaded);
      onSaved({ changed: false });
      return;
    }
    save.reset();
    setPending({ request: result.value, changes });
  }

  async function confirm() {
    if (!pending) return;
    try {
      const result = await save.mutateAsync({
        params: { tenantId: tenant.id },
        body: pending.request,
      });
      setPending(null);
      onSaved({ changed: result.auditId !== null });
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'validation') {
        setPending(null);
        setErrors(serverSettingsErrors(problem.issues, locale));
      }
    }
  }

  const overdraftHint = settingsAmountError(
    form.overdraftLimit,
    t('tenant:detail.overdraftLimit'),
    'overdraft',
    locale,
  )
    ? undefined
    : t('tenant:settings.overdraftHint', {
        amount: formatMoney({
          currency: tenant.currency,
          amount: normalizeAmountInput(form.overdraftLimit),
        }).replace(/^-/, ''),
      });

  return (
    <>
      <Card
        asChild
        className={cn(
          'block gap-0 bg-transparent py-0 text-inherit shadow-none',
          'flex max-w-[640px] flex-col rounded-xl border border-border',
        )}
      >
        <form
          noValidate
          aria-label={t('tenant:settings.formAria')}
          onSubmit={(event) => {
            event.preventDefault();
            review();
          }}
        >
          <div className="flex flex-col gap-[18px] px-4 py-5 md:px-6">
            {saved ? (
              <div
                role="status"
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-[13px]',
                  saved.changed
                    ? 'border-ok-border bg-ok-soft text-ok'
                    : 'border-border bg-muted text-muted-foreground',
                )}
              >
                {saved.changed
                  ? t('tenant:settings.savedChanged')
                  : t('tenant:settings.savedSame')}
              </div>
            ) : null}
            {errors.form ? (
              <p role="alert" className="m-0 text-[13px] text-err">
                {errors.form}
              </p>
            ) : null}
            <div className="grid gap-4 md:grid-cols-2">
              <Field
                label={t('tenant:detail.overdraftLimit')}
                error={errors.overdraftLimit}
                hint={errors.overdraftLimit ? undefined : overdraftHint}
              >
                {(props) => (
                  <MoneyInput
                    {...props}
                    currency={tenant.currency}
                    error={errors.overdraftLimit}
                    value={form.overdraftLimit}
                    onChange={(overdraftLimit) => update({ overdraftLimit })}
                  />
                )}
              </Field>
              <Field
                label={t('tenant:create.thresholdLabel')}
                error={errors.lowBalanceThreshold}
                hint={
                  errors.lowBalanceThreshold
                    ? undefined
                    : t('tenant:settings.thresholdHint')
                }
              >
                {(props) => (
                  <MoneyInput
                    {...props}
                    currency={tenant.currency}
                    error={errors.lowBalanceThreshold}
                    value={form.lowBalanceThreshold}
                    onChange={(lowBalanceThreshold) =>
                      update({ lowBalanceThreshold })
                    }
                  />
                )}
              </Field>
            </div>
            <RecipientsInput
              stacked
              emails={form.emails}
              error={errors.emails}
              onChange={(emails) => update({ emails })}
              {...(disabledAdmins.data ? { flagged: disabledAdmins.data } : {})}
            />
          </div>
          <div className="flex flex-col gap-3 border-t border-border px-4 py-3.5 md:flex-row md:items-center md:justify-between md:px-6">
            <span
              className={cn(
                'text-xs',
                errorCount ? 'text-err' : 'text-muted-foreground',
              )}
            >
              {errorCount
                ? t('tenant:settings.fixErrors', { count: errorCount })
                : t('tenant:settings.saveHint')}
            </span>
            <div className="flex flex-col-reverse gap-2 md:flex-row">
              <Button
                variant="outline"
                className="h-12 md:h-9"
                disabled={!dirty}
                onClick={() => {
                  setForm(loaded);
                  setErrors({});
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button
                type="submit"
                className="h-12 md:h-9"
                disabled={!dirty || errorCount > 0}
              >
                {t('tenant:settings.save')}
              </Button>
            </div>
          </div>
        </form>
      </Card>
      <ModalDialog
        open={pending !== null}
        {...(save.isPending
          ? {}
          : { onOpenChange: (open: boolean) => open || setPending(null) })}
        title={t('tenant:settings.confirmTitle')}
        description={`${tenant.code} ${tenant.name}`}
      >
        <div className="flex flex-col gap-1.5">
          <h2 className="m-0 text-[17px] font-semibold">
            {t('tenant:settings.confirmTitle')}
          </h2>
          <span className="text-sm text-muted-foreground">
            {tenant.code} {tenant.name}
          </span>
        </div>
        {pending ? (
          <ChangeSummary tenant={tenant} changes={pending.changes} />
        ) : null}
        {pending?.request.emails.length === 0 ? (
          <Alert variant="warning" role="note">
            {t('admin:recipients.emptyNote')}
          </Alert>
        ) : null}
        <Alert variant="brand">
          <span className="font-semibold text-primary">
            {t('tenant:settings.loggedTitle')}
          </span>
          <span>{t('tenant:settings.loggedBody')}</span>
        </Alert>
        {save.error ? (
          <ProblemAlert
            error={save.error}
            networkMessage={t('tenant:settings.saveNetwork')}
            onRefresh={() => {
              setPending(null);
              void invalidateTenant(queryClient, tenant.id);
            }}
          />
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={save.isPending}
            onClick={() => setPending(null)}
          >
            {t('tenant:settings.back')}
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={save.isPending}
            onClick={() => void confirm()}
          >
            {t('tenant:settings.confirmSave')}
          </Button>
        </div>
      </ModalDialog>
    </>
  );
}
