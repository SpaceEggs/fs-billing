import { OptionTabs } from '../../components/option-tabs';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  currencySchema,
  translate,
  type AdminCsvRowError,
  type AdminPortalAccountCreateRequest,
  type AdminPortalAccountCreateResponse,
  type AdminTenantCreateResponse,
  type AdminTenantSummary,
  type Currency,
  type Identity,
  type Locale,
} from '@fs-billing/shared';
import { XIcon, CheckIcon } from 'lucide-react';
import { Label } from '../../components/ui/label';
import { Textarea } from '../../components/ui/textarea';
import { Alert } from '../../components/ui/alert';
import { MobileBarButton } from '../../components/mobile-bar-button';
import { AppShell, PageBody } from '../../components/app-shell';
import {
  Field,
  FormSection,
  invalidClass,
  MoneyInput,
  RecipientsInput,
} from '../../components/admin/form-fields';
import { CopyField, SecretField } from '../../components/copy-field';
import { Button, buttonVariants } from '../../components/ui/button';
import { ModalDialog } from '../../components/modal-dialog';
import { Input } from '../../components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../components/ui/native-select';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
  useCredentialMutation,
} from '../../lib/admin-api';
import { ApiRequestError } from '../../lib/api';
import { apiProblem, csvRowText, problemNotice } from '../../lib/api-problem';
import {
  buildSubmission,
  changeCurrency,
  initialTenantForm,
  normalizedCode,
  serverFieldErrors,
  type FieldErrors,
  type RatesChoice,
  type TenantForm,
} from '../../lib/tenant-create';
import { csvTooLarge, fileToBase64 } from '../../lib/rate-csv';
import { RateCsvTemplateLink } from '../../components/admin/rate-csv-template-link';
import { useLocale } from '../../i18n';
import { cn } from '../../lib/utils';

const currencyKeys = {
  CNY: 'portal:settings.currencyNames.CNY',
  USD: 'portal:settings.currencyNames.USD',
} as const satisfies Record<Currency, string>;

type CopySource = Extract<RatesChoice, { kind: 'copy' }>['source'];
type PortalState =
  | { status: 'pending' }
  | { status: 'created'; response: AdminPortalAccountCreateResponse }
  | { status: 'failed'; error: unknown };
type Created = {
  tenant: AdminTenantCreateResponse['tenant'];
  rates: string;
  portalRequest: AdminPortalAccountCreateRequest;
  portal: PortalState;
};
function CurrencyChoice({
  value,
  onChange,
}: {
  value: Currency;
  onChange: (currency: Currency) => void;
}) {
  const { t } = useTranslation(['tenant', 'portal']);
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span aria-hidden>
        {t('tenant:create.currencyLabel')}
        <span aria-hidden className="text-err">
          {' '}
          *
        </span>
      </span>
      <OptionTabs
        label={t('tenant:create.currencyLabel')}
        options={currencySchema.options.map((currency) => ({
          value: currency,
          label: t(currencyKeys[currency]),
        }))}
        value={value}
        onChange={onChange}
        className="w-full"
      />
      <span className="text-xs font-normal text-muted-foreground">
        {t('tenant:create.currencyLocked')}
      </span>
    </div>
  );
}

function CsvPicker({
  file,
  reading,
  onSelect,
}: {
  file: { filename: string } | null;
  reading: string | null;
  onSelect: (file: File | null) => void;
}) {
  const { t } = useTranslation(['tenant']);
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <Label htmlFor={id}>{t('tenant:create.csvFile')}</Label>
      <Input
        id={id}
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
      />
      <RateCsvTemplateLink className="self-start" />
      <span
        role={reading ? 'status' : undefined}
        className="text-xs font-normal text-muted-foreground"
      >
        {reading
          ? t('tenant:create.readingFile', { filename: reading })
          : file
            ? t('tenant:create.selectedFile', { filename: file.filename })
            : t('tenant:create.csvHint')}
      </span>
    </div>
  );
}

/** 一次最多列出 100 个同币种租户，更多时按编码或名称在服务端搜索。 */
function CopySourcePicker({
  currency,
  source,
  onChange,
}: {
  currency: Currency;
  source: CopySource;
  onChange: (source: CopySource) => void;
}) {
  const { t } = useTranslation(['tenant']);
  const id = useId();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<AdminTenantSummary | null>(null);
  const term = search.trim();
  const tenants = useQuery({
    ...apiQuery('adminTenants', {
      query: { currency, pageSize: 100, ...(term ? { search: term } : {}) },
    }),
    placeholderData: keepPreviousData,
  });
  const rates = useQuery({
    ...apiQuery('adminRates', { params: { tenantId: picked?.id ?? '' } }),
    enabled: picked !== null,
  });
  const current = rates.data?.current;
  useEffect(() => {
    if (!picked || !current) return;
    if (source?.versionId === current.id) return;
    onChange({
      tenantId: picked.id,
      versionId: current.id,
      label: t('tenant:create.copiedLabel', {
        code: picked.code,
        count: current.entries.length,
      }),
    });
  }, [picked, current, source, onChange, t]);
  const items = tenants.data?.items ?? [];
  const options =
    picked && !items.some((item) => item.id === picked.id)
      ? [picked, ...items]
      : items;
  const total = tenants.data?.pagination.total ?? 0;
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium md:col-span-2">
      <Label htmlFor={`${id}-search`}>{t('tenant:create.searchSource')}</Label>
      <Input
        id={`${id}-search`}
        type="search"
        autoComplete="off"
        placeholder={t('tenant:create.searchSourcePlaceholder')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Label htmlFor={id}>{t('tenant:create.copyFrom')}</Label>
      <NativeSelect
        id={id}
        value={picked?.id ?? ''}
        disabled={!tenants.data}
        onChange={(event) => {
          setPicked(
            options.find((item) => item.id === event.target.value) ?? null,
          );
          onChange(null);
        }}
        containerClassName="font-normal md:h-10"
      >
        <NativeSelectOption value="">
          {tenants.isError
            ? t('tenant:create.tenantListFailed')
            : tenants.data
              ? items.length
                ? t('tenant:create.chooseTenant')
                : t('tenant:create.noSameCurrency')
              : t('tenant:create.loading')}
        </NativeSelectOption>
        {options.map((tenant) => (
          <NativeSelectOption key={tenant.id} value={tenant.id}>
            {tenant.code} {tenant.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <span className="text-xs font-normal text-muted-foreground">
        {rates.isError
          ? t('tenant:create.ratesLoadFailed')
          : current && picked
            ? t('tenant:create.currentVersionEntries', {
                count: current.entries.length,
              })
            : total > items.length
              ? t('tenant:create.moreTenants', {
                  total,
                  currency,
                  shown: items.length,
                })
              : t('tenant:create.sameCurrencyOnly', { currency })}
      </span>
    </div>
  );
}

function CsvErrors({ rows }: { rows: AdminCsvRowError[] }) {
  const { t } = useTranslation(['tenant']);
  return (
    <Alert variant="error" className="gap-2 px-3.5 py-3 md:col-span-2">
      <span className="font-semibold">
        {t('tenant:create.csvErrorsTitle', { count: rows.length })}
      </span>
      <ul className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0 tabular-nums">
        {rows.map((row) => (
          <li key={`${row.line}-${row.key}`}>
            {t('tenant:create.csvErrorLine', {
              line: row.line,
              message: csvRowText(row),
            })}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function PortalFailure({ error }: { error: unknown }) {
  const { t } = useTranslation(['tenant', 'common']);
  if (error instanceof ApiRequestError && error.outcomeUnknown)
    return (
      <span className="text-[13px]">{t('tenant:create.portalNetwork')}</span>
    );
  const notice = problemNotice(apiProblem(error));
  return (
    <>
      <span className="text-[13px]">
        {notice.body
          ? t('common:error.titleBody', {
              title: notice.title,
              body: notice.body,
            })
          : notice.title}
      </span>
      {notice.details?.length ? (
        <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-[13px]">
          {notice.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function PortalResult({
  created,
  onRetry,
}: {
  created: Created;
  onRetry: () => void;
}) {
  const { t } = useTranslation(['tenant']);
  const { portal, portalRequest } = created;
  if (portal.status === 'pending')
    return (
      <p role="status" className="m-0 text-sm text-muted-foreground">
        {t('tenant:create.portalCreating')}
      </p>
    );
  if (portal.status === 'failed')
    return (
      <Alert variant="error" className="gap-2 rounded-[10px] px-4 py-3.5">
        <span className="text-sm font-semibold">
          {t('tenant:create.portalFailed', { email: portalRequest.email })}
        </span>
        <PortalFailure error={portal.error} />
        <span className="text-xs text-foreground">
          {t('tenant:create.portalFailedBody')}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onRetry}
        >
          {t('tenant:create.retryPortal')}
        </Button>
      </Alert>
    );
  const { response } = portal;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border px-4 py-3.5">
      <span className="text-sm font-semibold">
        {t('tenant:create.portalCreated', { email: response.account.email })}
      </span>
      {response.passwordSource === 'generated' ? (
        <>
          <SecretField
            value={response.temporaryPassword}
            label={t('tenant:create.temporaryPassword')}
          />
          <Alert variant="warning">
            <span className="font-semibold">
              {t('tenant:create.oneTimeTitle')}
            </span>
            <span>{t('tenant:create.oneTimeBody')}</span>
          </Alert>
        </>
      ) : (
        <span className="text-[13px] text-muted-foreground">
          {t('tenant:create.initialPasswordUsed')}
        </span>
      )}
    </div>
  );
}

function CreatedDialog({
  created,
  onRetryPortal,
  onContinue,
  onView,
}: {
  created: Created;
  onRetryPortal: () => void;
  onContinue: () => void;
  onView: () => void;
}) {
  const { tenant } = created;
  const { t } = useTranslation(['tenant']);
  // 开通结果返回前离开会丢失只显示一次的临时密码，也可能把结果挂到下一个租户上。
  const portalPending = created.portal.status === 'pending';
  return (
    <ModalDialog
      open
      title={t('tenant:create.createdTitle', { code: tenant.code })}
      description={t('tenant:create.createdSubtitle', {
        name: tenant.name,
        currency: tenant.currency,
        rates: created.rates,
      })}
    >
      <div className="flex flex-col items-center gap-2.5 pt-2 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-[22px] font-bold text-ok"
        >
          <CheckIcon className="size-6" />
        </span>
        <h2 className="m-0 text-[17px] font-semibold">
          {t('tenant:create.createdTitle', { code: tenant.code })}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t('tenant:create.createdSubtitle', {
            name: tenant.name,
            currency: tenant.currency,
            rates: created.rates,
          })}
        </span>
      </div>
      <Alert variant="warning" className="gap-2.5 rounded-[10px] px-4 py-3.5">
        <span className="text-sm font-semibold text-warn">
          {t('tenant:create.nextStep')}
        </span>
        <CopyField
          value={`billing_tenant=${tenant.code}`}
          label={t('tenant:create.channelVariable')}
        />
        <span className="text-xs leading-relaxed text-foreground">
          {t('tenant:create.channelHint')}
        </span>
      </Alert>
      <PortalResult created={created} onRetry={onRetryPortal} />
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={portalPending}
          onClick={onContinue}
        >
          {t('tenant:create.continueCreate')}
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={portalPending}
          onClick={onView}
        >
          {t('tenant:create.viewTenant')}
        </Button>
      </div>
    </ModalDialog>
  );
}

function ratesSummary(rates: RatesChoice, locale: Locale) {
  if (rates.kind === 'csv')
    return translate(locale, 'tenant:create.ratesImported');
  if (rates.kind === 'copy' && rates.source) return rates.source.label;
  return translate(locale, 'tenant:create.ratesBlank');
}

/** 新建租户（第二批 4a–4e）：先开户，成功后单独开通门户账号。 */
export function TenantCreatePage({ identity }: { identity: Identity }) {
  const navigate = useNavigate();
  const { t } = useTranslation(['tenant', 'common']);
  const locale = useLocale();
  const adminEmail = identity.kind === 'admin' ? identity.email : '';
  const [form, setForm] = useState<TenantForm>(() =>
    initialTenantForm(adminEmail),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [csvRows, setCsvRows] = useState<AdminCsvRowError[] | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const createTenant = useApiMutation('adminTenantCreate', {
    invalidate: (queryClient, _input, result) =>
      invalidateTenant(queryClient, result.tenant.id),
  });
  const createPortal = useCredentialMutation('adminPortalAccountCreate');

  // 选择新文件、切换费率来源或离开页面都让进行中的读取作废。
  const csvReads = useRef(0);
  const [readingCsv, setReadingCsv] = useState<string | null>(null);
  useEffect(
    () => () => {
      csvReads.current += 1;
    },
    [],
  );

  const update = (patch: Partial<TenantForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const setRates = (rates: RatesChoice) => {
    csvReads.current += 1;
    setReadingCsv(null);
    setCsvRows(null);
    setErrors((current) => {
      const next = { ...current };
      delete next.rates;
      return next;
    });
    update({ rates });
  };
  const rateError = (message: string) =>
    setErrors((current) => ({ ...current, rates: message }));

  function pickCsv(selected: File | null) {
    setRates({ kind: 'csv', file: null });
    if (!selected) return;
    if (csvTooLarge(selected.size)) {
      rateError(t('tenant:create.fileTooLarge'));
      return;
    }
    const read = (csvReads.current += 1);
    setReadingCsv(selected.name);
    fileToBase64(selected).then(
      (contentBase64) => {
        if (read !== csvReads.current) return;
        setReadingCsv(null);
        update({
          rates: {
            kind: 'csv',
            file: { filename: selected.name, contentBase64 },
          },
        });
      },
      () => {
        if (read !== csvReads.current) return;
        setReadingCsv(null);
        rateError(t('tenant:create.fileReadFailed'));
      },
    );
  }

  async function openPortal(
    tenantId: string,
    body: AdminPortalAccountCreateRequest,
  ) {
    // 「继续新建」后旧租户的迟到结果不再落到新的对话框上。
    const settle = (portal: PortalState) =>
      setCreated((current) =>
        current?.tenant.id === tenantId ? { ...current, portal } : current,
      );
    settle({ status: 'pending' });
    try {
      const response = await createPortal.submit({
        params: { tenantId },
        body,
      });
      if (response) settle({ status: 'created', response });
    } catch (error) {
      settle({ status: 'failed', error });
    }
  }

  function showErrors(next: FieldErrors, title: string) {
    setErrors(next);
    setSummary(title);
    // 焦点移到第一个出错的输入框；没有可聚焦字段时移到顶部提示。
    requestAnimationFrame(() => {
      const target =
        document.querySelector<HTMLElement>('form [aria-invalid="true"]') ??
        document.querySelector<HTMLElement>('form [role="alert"]');
      target?.focus();
    });
  }

  function createFailed(error: unknown, code: string) {
    if (error instanceof ApiRequestError && error.outcomeUnknown) {
      showErrors(
        {},
        t('tenant:create.networkUnknownCreate', { code: code.toUpperCase() }),
      );
      return;
    }
    const problem = apiProblem(error);
    switch (problem.kind) {
      case 'validation': {
        const fields = serverFieldErrors(problem.issues, locale);
        showErrors(
          fields,
          t('tenant:create.fixCount', { count: Object.keys(fields).length }),
        );
        return;
      }
      case 'csv-invalid':
        setCsvRows(problem.rows);
        showErrors(
          {
            rates: t('tenant:create.csvRowCount', {
              count: problem.rows.length,
            }),
          },
          t('tenant:create.csvInvalid'),
        );
        return;
      case 'csv-rejected':
        showErrors({ rates: problem.message }, t('tenant:create.csvRejected'));
        return;
      case 'conflict':
        if (problem.code === 'TENANT_CODE_EXISTS') {
          showErrors(
            {
              code: t('tenant:create.codeExists', {
                code: code.toUpperCase(),
              }),
            },
            t('tenant:create.codeUsed'),
          );
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          showErrors(
            { rates: t('tenant:create.currencyMismatch') },
            t('tenant:create.sourceCurrencyMismatch'),
          );
          return;
        }
        showErrors({}, problem.message);
        return;
      case 'reauthenticate':
      case 'password-change-required':
        return;
      default: {
        const notice = problemNotice(problem);
        showErrors(
          {},
          notice.body
            ? t('common:error.titleBody', {
                title: notice.title,
                body: notice.body,
              })
            : notice.title,
        );
      }
    }
  }

  async function submit() {
    if (readingCsv) return;
    const built = buildSubmission(form, locale);
    if (!built.ok) {
      const count = Object.keys(built.errors).length;
      showErrors(
        built.errors,
        built.errors.form ?? t('tenant:create.fixCount', { count }),
      );
      return;
    }
    setErrors({});
    setSummary(null);
    setCsvRows(null);
    let response: AdminTenantCreateResponse;
    try {
      response = await createTenant.mutateAsync({ body: built.value.tenant });
    } catch (error) {
      createFailed(error, built.value.tenant.code);
      return;
    }
    setCreated({
      tenant: response.tenant,
      rates: ratesSummary(form.rates, locale),
      portalRequest: built.value.portal,
      portal: { status: 'pending' },
    });
    await openPortal(response.tenant.id, built.value.portal);
  }

  const codeHint = normalizedCode(form.code);
  const pending = createTenant.isPending || readingCsv !== null;
  const initialRateOptions = [
    {
      kind: 'blank',
      label: t('tenant:create.rateBlank'),
      sub: t('tenant:create.rateBlankSub'),
    },
    {
      kind: 'csv',
      label: t('tenant:create.rateCsv'),
      sub: t('tenant:create.rateCsvSub'),
    },
    {
      kind: 'copy',
      label: t('tenant:create.rateCopy'),
      sub: t('tenant:create.rateCopySub'),
    },
  ] as const;

  return (
    <AppShell
      identity={identity}
      title={t('tenant:create.title')}
      crumb={
        <>
          <Link to="/admin/tenants" className="text-primary">
            {t('tenant:detail.tenant')}
          </Link>{' '}
          / <span className="text-foreground">{t('tenant:create.title')}</span>
        </>
      }
      activeNav={translate('zh', 'shell:nav.tenants')}
      mobileNav={
        <MobileBarButton asChild>
          <Link to="/admin/tenants" aria-label={t('tenant:create.cancelAria')}>
            <XIcon aria-hidden />
          </Link>
        </MobileBarButton>
      }
    >
      <PageBody title={t('tenant:create.title')}>
        <form
          noValidate
          aria-label={t('tenant:create.title')}
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) void submit();
          }}
          className="flex max-w-[1020px] flex-col"
        >
          <span className="-mt-3 hidden pb-5 text-[13px] text-muted-foreground md:block">
            {t('tenant:create.requiredHintPrefix')}
            <span className="text-err">*</span>
            {t('tenant:create.requiredHintSuffix')}
          </span>
          {summary ? (
            <div
              role="alert"
              tabIndex={-1}
              className="mb-4 flex items-center gap-2 rounded-[10px] border border-err-border bg-err-soft px-3.5 py-2.5 text-sm font-medium text-err outline-none"
            >
              <span aria-hidden className="font-bold">
                !
              </span>
              {summary}
            </div>
          ) : null}

          <FormSection
            title={t('tenant:create.basicSection')}
            description={t('tenant:create.basicDescription')}
          >
            <Field
              label={t('tenant:create.codeLabel')}
              required
              error={errors.code}
              hint={
                <>
                  {codeHint
                    ? t('tenant:create.codeWillSave', { code: codeHint })
                    : null}
                  {t('tenant:create.codeHintPrefix')}
                  <span className="font-mono text-foreground">
                    billing_tenant
                  </span>
                  {t('tenant:create.codeHintSuffix')}
                </>
              }
            >
              {(props) => (
                <Input
                  {...props}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  placeholder={t('tenant:create.codePlaceholder')}
                  value={form.code}
                  onChange={(event) => update({ code: event.target.value })}
                  className={cn('font-mono', invalidClass(errors.code))}
                />
              )}
            </Field>
            <Field
              label={t('tenant:create.nameLabel')}
              required
              error={errors.name}
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  placeholder={t('tenant:create.namePlaceholder')}
                  value={form.name}
                  onChange={(event) => update({ name: event.target.value })}
                  className={invalidClass(errors.name)}
                />
              )}
            </Field>
            <CurrencyChoice
              value={form.currency}
              onChange={(currency) =>
                setForm((current) => changeCurrency(current, currency))
              }
            />
          </FormSection>

          <FormSection
            title={t('tenant:create.quotaSection')}
            description={t('tenant:create.quotaDescription')}
          >
            <div className="grid grid-cols-2 gap-2.5 md:contents">
              <Field
                label={t('tenant:detail.overdraftLimit')}
                required
                error={errors.overdraftLimit}
                hint={
                  form.overdraftEdited ? undefined : (
                    <span className="hidden text-primary md:inline">
                      {t('tenant:create.overdraftDefaultHint')}
                    </span>
                  )
                }
              >
                {(props) => (
                  <MoneyInput
                    {...props}
                    currency={form.currency}
                    error={errors.overdraftLimit}
                    value={form.overdraftLimit}
                    onChange={(overdraftLimit) =>
                      update({ overdraftLimit, overdraftEdited: true })
                    }
                  />
                )}
              </Field>
              <Field
                label={t('tenant:create.thresholdLabel')}
                shortLabel={t('tenant:create.thresholdShort')}
                required
                error={errors.lowBalanceThreshold}
              >
                {(props) => (
                  <MoneyInput
                    {...props}
                    currency={form.currency}
                    error={errors.lowBalanceThreshold}
                    placeholder={t('tenant:create.thresholdPlaceholder')}
                    value={form.lowBalanceThreshold}
                    onChange={(lowBalanceThreshold) =>
                      update({ lowBalanceThreshold })
                    }
                  />
                )}
              </Field>
            </div>
            <RecipientsInput
              emails={form.emails}
              error={errors.emails}
              onChange={(emails) => update({ emails })}
            />
          </FormSection>

          <FormSection
            title={t('tenant:create.contactSection')}
            description={t('tenant:create.contactDescription')}
          >
            <Field
              label={t('tenant:create.contactName')}
              error={errors.contactName}
            >
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  placeholder={t('tenant:create.optionalPlaceholder')}
                  value={form.contactName}
                  onChange={(event) =>
                    update({ contactName: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label={t('tenant:create.phone')} error={errors.contactPhone}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={100}
                  placeholder={t('tenant:create.optionalPlaceholder')}
                  value={form.contactPhone}
                  onChange={(event) =>
                    update({ contactPhone: event.target.value })
                  }
                  className="tabular-nums"
                />
              )}
            </Field>
            <Field
              label={t('tenant:create.remark')}
              error={errors.remark}
              className="md:col-span-2"
            >
              {(props) => (
                <Textarea
                  {...props}
                  maxLength={2000}
                  placeholder={t('tenant:create.optionalPlaceholder')}
                  value={form.remark}
                  onChange={(event) => update({ remark: event.target.value })}
                  className="min-h-16 py-2.5 font-normal"
                />
              )}
            </Field>
          </FormSection>

          <FormSection
            title={t('tenant:create.portalSection')}
            description={t('tenant:create.portalDescription')}
          >
            <Field
              label={t('tenant:create.portalEmail')}
              required
              error={errors.portalEmail}
            >
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  autoComplete="off"
                  placeholder="name@company.com"
                  value={form.portalEmail}
                  onChange={(event) =>
                    update({ portalEmail: event.target.value })
                  }
                  className={invalidClass(errors.portalEmail)}
                />
              )}
            </Field>
            <Field
              label={t('tenant:create.initialPassword')}
              error={errors.portalPassword}
              hint={t('tenant:create.passwordHint')}
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  placeholder={t('tenant:create.passwordPlaceholder')}
                  value={form.portalPassword}
                  onChange={(event) =>
                    update({ portalPassword: event.target.value })
                  }
                  className={cn(
                    'font-mono',
                    invalidClass(errors.portalPassword),
                  )}
                />
              )}
            </Field>
          </FormSection>

          <FormSection
            title={t('tenant:create.ratesSection')}
            description={t('tenant:create.ratesDescription')}
          >
            <RadioGroup
              aria-label={t('tenant:create.initialRatesAria')}
              value={form.rates.kind}
              onValueChange={(kind) =>
                setRates(
                  kind === 'blank'
                    ? { kind: 'blank' }
                    : kind === 'csv'
                      ? { kind: 'csv', file: null }
                      : { kind: 'copy', source: null },
                )
              }
              className="gap-2.5 md:col-span-2 md:grid-cols-3"
            >
              {initialRateOptions.map((option) => (
                <label
                  key={option.kind}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-input p-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft"
                >
                  <RadioGroupItem value={option.kind} className="mt-0.5" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="hidden text-xs text-muted-foreground md:block">
                      {option.sub}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            {form.rates.kind === 'csv' ? (
              <CsvPicker
                file={form.rates.file}
                reading={readingCsv}
                onSelect={pickCsv}
              />
            ) : null}
            {form.rates.kind === 'copy' ? (
              <CopySourcePicker
                key={form.currency}
                currency={form.currency}
                source={form.rates.source}
                onChange={(source) =>
                  setForm((current) => ({
                    ...current,
                    rates: { kind: 'copy', source },
                  }))
                }
              />
            ) : null}
            {errors.rates ? (
              <span className="text-xs text-err md:col-span-2">
                {errors.rates}
              </span>
            ) : null}
            {csvRows ? <CsvErrors rows={csvRows} /> : null}
          </FormSection>

          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background pt-4 pb-6">
            <Link
              to="/admin/tenants"
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'hidden md:inline-flex',
              )}
            >
              {t('common:action.cancel')}
            </Link>
            <Button
              type="submit"
              disabled={pending}
              className="h-12 flex-1 text-base md:h-9 md:flex-none md:text-sm"
            >
              {createTenant.isPending
                ? t('tenant:create.creating')
                : readingCsv
                  ? t('tenant:create.readingCsv')
                  : t('tenant:create.create')}
            </Button>
          </div>
        </form>
        {created ? (
          <CreatedDialog
            created={created}
            onRetryPortal={() =>
              void openPortal(created.tenant.id, created.portalRequest)
            }
            onContinue={() => {
              setCreated(null);
              setForm(initialTenantForm(adminEmail));
              createPortal.reset();
            }}
            onView={() =>
              void navigate({
                to: '/admin/tenants/$tenantId',
                params: { tenantId: created.tenant.id },
              })
            }
          />
        ) : null}
      </PageBody>
    </AppShell>
  );
}
