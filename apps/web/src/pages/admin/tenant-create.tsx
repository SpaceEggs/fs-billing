import { useEffect, useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  currencySchema,
  type AdminCsvRowError,
  type AdminPortalAccountCreateRequest,
  type AdminPortalAccountCreateResponse,
  type AdminTenantCreateResponse,
  type AdminTenantSummary,
  type Currency,
  type Identity,
} from '@fs-billing/shared';
import { XIcon } from 'lucide-react';
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
import { apiProblem, problemNotice } from '../../lib/api-problem';
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
import { cn } from '../../lib/utils';

const currencyLabel = {
  CNY: 'CNY 人民币',
  USD: 'USD 美元',
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
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span id={`${id}-label`}>
        币种
        <span aria-hidden className="text-err">
          {' '}
          *
        </span>
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        className="grid h-11 grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px] md:h-10"
      >
        {currencySchema.options.map((currency) => (
          <label
            key={currency}
            className="relative flex cursor-pointer items-center justify-center rounded-md text-sm font-normal text-muted-foreground has-checked:bg-background has-checked:font-semibold has-checked:text-primary has-checked:shadow-[0_1px_2px_rgba(0,0,0,.12)] has-focus-visible:ring-[3px] has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name={id}
              value={currency}
              checked={value === currency}
              onChange={() => onChange(currency)}
              className="absolute inset-0 cursor-pointer appearance-none outline-none"
            />
            {currencyLabel[currency]}
          </label>
        ))}
      </div>
      <span className="text-xs font-normal text-muted-foreground">
        创建后不可修改
      </span>
    </div>
  );
}

const rateOptions = [
  { kind: 'blank', label: '空白费率表', sub: '创建后再逐条添加或导入' },
  {
    kind: 'csv',
    label: '从 CSV 导入',
    sub: '随开户一起导入，任何一行有错都不会创建租户',
  },
  {
    kind: 'copy',
    label: '复制某个租户的费率表',
    sub: '以同币种租户的费率表为模板',
  },
] as const;

function CsvPicker({
  file,
  reading,
  onSelect,
}: {
  file: { filename: string } | null;
  reading: string | null;
  onSelect: (file: File | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <Label htmlFor={id}>CSV 文件</Label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => onSelect(event.target.files?.[0] ?? null)}
        className="text-[13px] font-normal file:mr-3 file:h-9 file:rounded-lg file:border file:border-input file:bg-transparent file:px-3 file:text-sm file:text-foreground"
      />
      <RateCsvTemplateLink className="self-start" />
      <span
        role={reading ? 'status' : undefined}
        className="text-xs font-normal text-muted-foreground"
      >
        {reading
          ? `正在读取 ${reading}…`
          : file
            ? `已选择 ${file.filename}`
            : '整表导入；首行必须为表头 ISO,Country,Destination Prefix,Description,Rate 或 ISO,国家,号码前缀,说明,费率；支持 UTF-8 与 GBK'}
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
      label: `已复制 ${picked.code} 的 ${current.entries.length} 条费率`,
    });
  }, [picked, current, source, onChange]);
  const items = tenants.data?.items ?? [];
  const options =
    picked && !items.some((item) => item.id === picked.id)
      ? [picked, ...items]
      : items;
  const total = tenants.data?.pagination.total ?? 0;
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium md:col-span-2">
      <Label htmlFor={`${id}-search`}>搜索来源租户</Label>
      <Input
        id={`${id}-search`}
        type="search"
        autoComplete="off"
        placeholder="输入编码或名称"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <Label htmlFor={id}>复制自</Label>
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
            ? '租户列表加载失败'
            : tenants.data
              ? items.length
                ? '选择租户'
                : '没有匹配的同币种租户'
              : '加载中…'}
        </NativeSelectOption>
        {options.map((tenant) => (
          <NativeSelectOption key={tenant.id} value={tenant.id}>
            {tenant.code} {tenant.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <span className="text-xs font-normal text-muted-foreground">
        {rates.isError
          ? '该租户的费率表加载失败，请重新选择'
          : current && picked
            ? `当前生效版本 ${current.entries.length} 条费率`
            : total > items.length
              ? `共 ${total} 个匹配的同币种（${currency}）租户，仅列出前 ${items.length} 个，请输入编码或名称缩小范围`
              : `仅显示同币种（${currency}）的租户`}
      </span>
    </div>
  );
}

function CsvErrors({ rows }: { rows: AdminCsvRowError[] }) {
  return (
    <Alert variant="error" className="gap-2 px-3.5 py-3 md:col-span-2">
      <span className="font-semibold">
        CSV 有 {rows.length} 行错误，租户未创建
      </span>
      <ul className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0 tabular-nums">
        {rows.map((row) => (
          <li key={`${row.line}-${row.reason}`}>
            第 {row.line} 行：{row.reason}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function PortalFailure({ error }: { error: unknown }) {
  if (error instanceof ApiRequestError && error.outcomeUnknown)
    return (
      <span className="text-[13px]">
        网络中断，无法确认是否已开通。请先在租户详情「门户账号」标签页查看，不要重复开通。
      </span>
    );
  const notice = problemNotice(apiProblem(error));
  return (
    <>
      <span className="text-[13px]">
        {notice.body ? `${notice.title}，${notice.body}` : notice.title}
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
  const { portal, portalRequest } = created;
  if (portal.status === 'pending')
    return (
      <p role="status" className="m-0 text-sm text-muted-foreground">
        正在开通门户账号…
      </p>
    );
  if (portal.status === 'failed')
    return (
      <Alert variant="error" className="gap-2 rounded-[10px] px-4 py-3.5">
        <span className="text-sm font-semibold">
          门户账号 {portalRequest.email} 未开通
        </span>
        <PortalFailure error={portal.error} />
        <span className="text-xs text-foreground">
          租户已创建。可以重试，或稍后在租户详情「门户账号」标签页开通。
        </span>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={onRetry}
        >
          重试开通
        </Button>
      </Alert>
    );
  const { response } = portal;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border px-4 py-3.5">
      <span className="text-sm font-semibold">
        门户账号 {response.account.email} 已开通
      </span>
      {response.passwordSource === 'generated' ? (
        <>
          <SecretField value={response.temporaryPassword} label="临时密码" />
          <Alert variant="warning">
            <span className="font-semibold">
              只显示一次，关闭后无法再次查看
            </span>
            <span>
              请立即复制并通过安全渠道发给客户，客户首次登录后需修改密码。
            </span>
          </Alert>
        </>
      ) : (
        <span className="text-[13px] text-muted-foreground">
          使用填写的初始密码，客户首次登录后需修改密码。
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
  // 开通结果返回前离开会丢失只显示一次的临时密码，也可能把结果挂到下一个租户上。
  const portalPending = created.portal.status === 'pending';
  return (
    <ModalDialog
      open
      title={`租户 ${tenant.code} 已创建`}
      description={`${tenant.name}（${tenant.currency}）· ${created.rates}`}
    >
      <div className="flex flex-col items-center gap-2.5 pt-2 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-[22px] font-bold text-ok"
        >
          ✓
        </span>
        <h2 className="m-0 text-[17px] font-semibold">
          租户 {tenant.code} 已创建
        </h2>
        <span className="text-sm text-muted-foreground">
          {tenant.name}（{tenant.currency}）· {created.rates}
        </span>
      </div>
      <Alert variant="warning" className="gap-2.5 rounded-[10px] px-4 py-3.5">
        <span className="text-sm font-semibold text-warn">
          下一步：请在 FreeSWITCH 中设置
        </span>
        <CopyField
          value={`billing_tenant=${tenant.code}`}
          label="FreeSWITCH 通道变量"
        />
        <span className="text-xs leading-relaxed text-foreground">
          在该客户的 SIP 账号或 IP
          对接上设置此通道变量，否则话单会进入「未归属话单」。
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
          继续新建
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={portalPending}
          onClick={onView}
        >
          查看租户
        </Button>
      </div>
    </ModalDialog>
  );
}

function ratesSummary(rates: RatesChoice) {
  if (rates.kind === 'csv') return '已导入 CSV 费率表';
  if (rates.kind === 'copy' && rates.source) return rates.source.label;
  return '空白费率表';
}

/** 新建租户（第二批 4a–4e）：先开户，成功后单独开通门户账号。 */
export function TenantCreatePage({ identity }: { identity: Identity }) {
  const navigate = useNavigate();
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
      rateError('文件超过 2 MB 上限');
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
        rateError('文件读取失败，请重新选择');
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
        `网络中断，无法确认租户是否已创建。请先在租户列表搜索编码 ${code.toUpperCase()} 确认，不要直接重复提交。`,
      );
      return;
    }
    const problem = apiProblem(error);
    switch (problem.kind) {
      case 'validation': {
        const fields = serverFieldErrors(problem.issues);
        showErrors(fields, `有 ${Object.keys(fields).length} 处需要修改`);
        return;
      }
      case 'csv-invalid':
        setCsvRows(problem.rows);
        showErrors(
          { rates: `CSV 有 ${problem.rows.length} 行错误` },
          '费率表 CSV 有错误，租户未创建',
        );
        return;
      case 'csv-rejected':
        showErrors(
          { rates: problem.message },
          '费率表 CSV 无法导入，租户未创建',
        );
        return;
      case 'conflict':
        if (problem.code === 'TENANT_CODE_EXISTS') {
          showErrors(
            { code: `编码 ${code.toUpperCase()} 已存在，请换一个` },
            '租户编码已被使用',
          );
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          showErrors(
            { rates: '来源租户的币种与新租户不一致，请重新选择' },
            '费率表来源币种不一致',
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
          notice.body ? `${notice.title}，${notice.body}` : notice.title,
        );
      }
    }
  }

  async function submit() {
    if (readingCsv) return;
    const built = buildSubmission(form);
    if (!built.ok) {
      const count = Object.keys(built.errors).length;
      showErrors(built.errors, built.errors.form ?? `有 ${count} 处需要修改`);
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
      rates: ratesSummary(form.rates),
      portalRequest: built.value.portal,
      portal: { status: 'pending' },
    });
    await openPortal(response.tenant.id, built.value.portal);
  }

  const rateGroup = useId();
  const codeHint = normalizedCode(form.code);
  const pending = createTenant.isPending || readingCsv !== null;

  return (
    <AppShell
      identity={identity}
      title="新建租户"
      crumb={
        <>
          <Link to="/admin/tenants" className="text-primary">
            租户
          </Link>{' '}
          / <span className="text-foreground">新建租户</span>
        </>
      }
      activeNav="租户"
      mobileNav={
        <MobileBarButton asChild>
          <Link to="/admin/tenants" aria-label="取消新建，返回租户列表">
            <XIcon aria-hidden />
          </Link>
        </MobileBarButton>
      }
    >
      <PageBody title="新建租户">
        <form
          noValidate
          aria-label="新建租户"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) void submit();
          }}
          className="flex max-w-[1020px] flex-col"
        >
          <span className="-mt-3 hidden pb-5 text-[13px] text-muted-foreground md:block">
            带 <span className="text-err">*</span> 为必填
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

          <FormSection title="基本信息" description="编码和币种创建后不可修改">
            <Field
              label="租户编码"
              required
              error={errors.code}
              hint={
                <>
                  {codeHint ? `将保存为大写 ${codeHint}。` : null}
                  字母和数字。须与 FreeSWITCH 中的{' '}
                  <span className="font-mono text-foreground">
                    billing_tenant
                  </span>{' '}
                  一致
                </>
              }
            >
              {(props) => (
                <Input
                  {...props}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={64}
                  placeholder="例如 ABC001"
                  value={form.code}
                  onChange={(event) => update({ code: event.target.value })}
                  className={cn('font-mono', invalidClass(errors.code))}
                />
              )}
            </Field>
            <Field label="租户名称" required error={errors.name}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  placeholder="公司全称"
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
            title="额度与提醒"
            description="余额 + 透支额度用完后停机；余额低于阈值时发邮件提醒"
          >
            <div className="grid grid-cols-2 gap-2.5 md:contents">
              <Field
                label="透支额度"
                required
                error={errors.overdraftLimit}
                hint={
                  form.overdraftEdited ? undefined : (
                    <span className="hidden text-primary md:inline">
                      默认 CNY 100 / USD 15，切换币种时自动更新
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
                label="余额提醒阈值"
                shortLabel="提醒阈值"
                required
                error={errors.lowBalanceThreshold}
              >
                {(props) => (
                  <MoneyInput
                    {...props}
                    currency={form.currency}
                    error={errors.lowBalanceThreshold}
                    placeholder="例如 200.00"
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

          <FormSection title="联系信息" description="可选，仅内部可见">
            <Field label="联系人" error={errors.contactName}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  placeholder="选填"
                  value={form.contactName}
                  onChange={(event) =>
                    update({ contactName: event.target.value })
                  }
                />
              )}
            </Field>
            <Field label="电话" error={errors.contactPhone}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={100}
                  placeholder="选填"
                  value={form.contactPhone}
                  onChange={(event) =>
                    update({ contactPhone: event.target.value })
                  }
                  className="tabular-nums"
                />
              )}
            </Field>
            <Field label="备注" error={errors.remark} className="md:col-span-2">
              {(props) => (
                <Textarea
                  {...props}
                  maxLength={2000}
                  placeholder="选填"
                  value={form.remark}
                  onChange={(event) => update({ remark: event.target.value })}
                  className="min-h-16 py-2.5 font-normal"
                />
              )}
            </Field>
          </FormSection>

          <FormSection
            title="门户账号"
            description="客户登录客户门户使用；初始密码只在创建成功后显示一次"
          >
            <Field label="登录邮箱" required error={errors.portalEmail}>
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
              label="初始密码"
              error={errors.portalPassword}
              hint="留空由系统生成临时密码；客户首次登录后需修改密码"
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  placeholder="至少 8 位"
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
            title="费率表"
            description="没有费率的前缀，呼叫会被拒绝"
          >
            <div
              role="radiogroup"
              aria-label="初始费率表"
              className="grid gap-2.5 md:col-span-2 md:grid-cols-3"
            >
              {rateOptions.map((option) => (
                <label
                  key={option.kind}
                  className="relative flex cursor-pointer items-start gap-2.5 rounded-lg border border-input p-3 has-checked:border-[1.5px] has-checked:border-primary has-checked:bg-brand-soft has-focus-visible:ring-[3px] has-focus-visible:ring-ring"
                >
                  <input
                    type="radio"
                    name={rateGroup}
                    value={option.kind}
                    checked={form.rates.kind === option.kind}
                    onChange={() =>
                      setRates(
                        option.kind === 'blank'
                          ? { kind: 'blank' }
                          : option.kind === 'csv'
                            ? { kind: 'csv', file: null }
                            : { kind: 'copy', source: null },
                      )
                    }
                    className="peer absolute inset-0 cursor-pointer appearance-none outline-none"
                  />
                  <span
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 rounded-full border-[1.5px] border-input peer-checked:border-[5px] peer-checked:border-primary"
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{option.label}</span>
                    <span className="hidden text-xs text-muted-foreground md:block">
                      {option.sub}
                    </span>
                  </span>
                </label>
              ))}
            </div>
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
              取消
            </Link>
            <Button
              type="submit"
              disabled={pending}
              className="h-12 flex-1 text-base md:h-9 md:flex-none md:text-sm"
            >
              {createTenant.isPending
                ? '创建中…'
                : readingCsv
                  ? '正在读取 CSV…'
                  : '创建租户'}
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
