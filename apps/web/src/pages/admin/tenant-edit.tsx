import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  adminTenantEditRequestSchema,
  translate,
  type AdminTenantDetailResponse,
  type AdminTenantEditRequest,
  type Identity,
  type Locale,
} from '@fs-billing/shared';
import { XIcon } from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton';
import { Textarea } from '../../components/ui/textarea';
import { MobileBarButton } from '../../components/mobile-bar-button';
import {
  Field,
  FormSection,
  invalidClass,
} from '../../components/admin/form-fields';
import { ProblemAlert } from '../../components/admin/problem-alert';
import { AppShell, PageBody } from '../../components/app-shell';
import { QueryError } from '../../components/query-error';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
} from '../../lib/admin-api';
import { apiProblem, fieldIssues } from '../../lib/api-problem';
import { useLocale } from '../../i18n';
import { cn } from '../../lib/utils';

type EditField = keyof AdminTenantEditRequest;

const limits = {
  name: 200,
  contactName: 200,
  contactPhone: 100,
  remark: 2000,
} as const satisfies Record<EditField, number>;

function localErrors(form: AdminTenantEditRequest, locale: Locale) {
  const errors: Partial<Record<EditField, string>> = {};
  if (!form.name.trim())
    errors.name = translate(locale, 'admin:tenant.create.nameRequired');
  for (const field of Object.keys(limits) as EditField[])
    if (!errors[field] && form[field].trim().length > limits[field])
      errors[field] = translate(locale, 'tenant:edit.tooLong', {
        max: limits[field],
      });
  return errors;
}

function EditForm({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const navigate = useNavigate();
  const { t } = useTranslation(['tenant', 'common']);
  const locale = useLocale();
  const [form, setForm] = useState<AdminTenantEditRequest>({
    name: tenant.name,
    contactName: tenant.contactName,
    contactPhone: tenant.contactPhone,
    remark: tenant.remark,
  });
  const [errors, setErrors] = useState<Partial<Record<EditField, string>>>({});
  const [unchanged, setUnchanged] = useState(false);
  const edit = useApiMutation('adminTenantEdit', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const update = (patch: Partial<AdminTenantEditRequest>) => {
    setForm((current) => ({ ...current, ...patch }));
    setErrors({});
    setUnchanged(false);
  };
  const back = () =>
    void navigate({
      to: '/admin/tenants/$tenantId',
      params: { tenantId: tenant.id },
    });

  async function submit() {
    const found = localErrors(form, locale);
    if (Object.keys(found).length) {
      setErrors(found);
      return;
    }
    const body = adminTenantEditRequestSchema.parse({
      name: form.name.trim(),
      contactName: form.contactName.trim(),
      contactPhone: form.contactPhone.trim(),
      remark: form.remark.trim(),
    });
    try {
      const result = await edit.mutateAsync({
        params: { tenantId: tenant.id },
        body,
      });
      if (result.auditId === null) setUnchanged(true);
      else back();
    } catch (error) {
      const issues = fieldIssues(apiProblem(error));
      setErrors(
        Object.fromEntries(
          (Object.keys(limits) as EditField[]).flatMap((field) => {
            const message = issues.get(field);
            return message ? [[field, message]] : [];
          }),
        ),
      );
    }
  }

  const text = (field: EditField, label: string, required = false) => (
    <Field label={label} required={required} error={errors[field]}>
      {(props) => (
        <Input
          {...props}
          maxLength={limits[field]}
          placeholder={
            required ? undefined : t('tenant:create.optionalPlaceholder')
          }
          value={form[field]}
          onChange={(event) => update({ [field]: event.target.value })}
          className={invalidClass(errors[field])}
        />
      )}
    </Field>
  );

  return (
    <form
      noValidate
      aria-label={t('tenant:edit.title')}
      onSubmit={(event) => {
        event.preventDefault();
        if (!edit.isPending) void submit();
      }}
      className="flex max-w-[1020px] flex-col"
    >
      <span className="-mt-3 hidden pb-5 text-[13px] text-muted-foreground md:block">
        {t('tenant:create.requiredHintPrefix')}
        <span className="text-err">*</span>
        {t('tenant:create.requiredHintSuffix')}
      </span>
      {unchanged ? (
        <div
          role="status"
          className="mb-4 rounded-[10px] border border-border bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        >
          {t('tenant:edit.unchanged')}
        </div>
      ) : null}
      {edit.error && apiProblem(edit.error).kind !== 'validation' ? (
        <div className="mb-4">
          <ProblemAlert
            error={edit.error}
            networkMessage={t('tenant:edit.saveNetwork')}
          />
        </div>
      ) : null}
      <FormSection
        title={t('tenant:create.basicSection')}
        description={t('tenant:create.basicDescription')}
      >
        <div className="flex flex-col gap-1.5 text-sm font-medium">
          <span>
            {t('tenant:create.codeLabel')}
            <RequiredMark />
            <LockedHint className="ml-2" />
          </span>
          <span className="flex h-11 items-center rounded-lg border border-input bg-muted px-3 font-mono font-normal md:h-10">
            {tenant.code}
          </span>
          <span className="text-xs leading-normal font-normal text-muted-foreground">
            {t('tenant:edit.codeHintPrefix')}
            <span className="font-mono text-foreground">billing_tenant</span>
            {t('tenant:edit.codeHintSuffix')}
          </span>
        </div>
        {text('name', t('tenant:create.nameLabel'), true)}
        <div className="flex flex-col gap-1.5 text-sm font-medium">
          <span>
            {t('tenant:create.currencyLabel')}
            <RequiredMark />
          </span>
          <span className="flex h-11 items-center justify-between gap-2 rounded-lg border border-input bg-muted px-3 font-normal md:h-10">
            {tenant.currency}
            <LockedHint />
          </span>
        </div>
      </FormSection>
      <FormSection
        title={t('tenant:create.contactSection')}
        description={t('tenant:create.contactDescription')}
      >
        {text('contactName', t('tenant:create.contactName'))}
        {text('contactPhone', t('tenant:create.phone'))}
        <Field
          label={t('tenant:create.remark')}
          error={errors.remark}
          className="md:col-span-2"
        >
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={limits.remark}
              placeholder={t('tenant:create.optionalPlaceholder')}
              value={form.remark}
              onChange={(event) => update({ remark: event.target.value })}
              className="resize-y font-normal"
            />
          )}
        </Field>
      </FormSection>
      <p className="m-0 border-t border-border py-4 text-[13px] text-muted-foreground">
        {t('tenant:edit.settingsHint')}
      </p>
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-border bg-background pt-4 pb-6 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="hidden md:inline-flex"
          onClick={back}
        >
          {t('common:action.cancel')}
        </Button>
        <Button type="submit" className="h-12 md:h-9" disabled={edit.isPending}>
          {t('tenant:edit.save')}
        </Button>
      </div>
    </form>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden className="text-err">
      {' '}
      *
    </span>
  );
}

/** 只读字段的「🔒 创建后不可修改」（稿 5a）。 */
function LockedHint({ className }: { className?: string }) {
  const { t } = useTranslation(['tenant']);
  return (
    <span
      className={cn('text-xs font-normal text-muted-foreground', className)}
    >
      <span aria-hidden>🔒 </span>
      {t('tenant:edit.locked')}
    </span>
  );
}

/** 编辑租户（设计稿第二批 5a）：名称与联系信息；编码、币种只读。 */
export function TenantEditPage({ identity }: { identity: Identity }) {
  const { tenantId } = useParams({ from: '/admin/tenants/$tenantId/edit' });
  const { t } = useTranslation(['tenant']);
  const detail = useQuery(
    apiQuery('adminTenantDetail', { params: { tenantId } }),
  );
  const tenant = detail.data;
  return (
    <AppShell
      identity={identity}
      title={t('tenant:edit.title')}
      crumb={
        <>
          <Link to="/admin/tenants" className="text-primary">
            {t('tenant:detail.tenant')}
          </Link>
          {tenant ? (
            <>
              {' / '}
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId }}
                className="text-primary"
              >
                {tenant.code}
              </Link>
            </>
          ) : null}{' '}
          /{' '}
          <span className="text-foreground">{t('tenant:edit.crumbEdit')}</span>
        </>
      }
      activeNav={translate('zh', 'shell:nav.tenants')}
      mobileNav={
        <MobileBarButton asChild>
          <Link
            to="/admin/tenants/$tenantId"
            params={{ tenantId }}
            aria-label={t('tenant:edit.cancelAria')}
          >
            <XIcon aria-hidden />
          </Link>
        </MobileBarButton>
      }
    >
      <PageBody title={t('tenant:edit.title')}>
        {tenant ? (
          <EditForm tenant={tenant} />
        ) : detail.isError ? (
          <QueryError
            title={t('tenant:detail.loadFailed')}
            error={detail.error}
            retrying={detail.isFetching}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <Skeleton
            aria-busy
            aria-label={t('tenant:detail.loading')}
            className="h-[240px] rounded-xl"
          />
        )}
      </PageBody>
    </AppShell>
  );
}
