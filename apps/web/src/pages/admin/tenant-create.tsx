import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  currencySchema,
  type AdminCsvRowError,
  type AdminPortalAccountCreateRequest,
  type AdminPortalAccountCreateResponse,
  type AdminTenantCreateResponse,
  type Currency,
  type Identity,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { CopyField } from '../../components/copy-field';
import { Button, buttonVariants } from '../../components/ui/button';
import { ModalDialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
} from '../../lib/admin-api';
import { ApiRequestError, callApi } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import {
  addRecipients,
  buildSubmission,
  changeCurrency,
  csvTooLarge,
  fileToBase64,
  initialTenantForm,
  normalizedCode,
  serverFieldErrors,
  type FieldErrors,
  type RatesChoice,
  type TenantForm,
} from '../../lib/tenant-create';
import { cn } from '../../lib/utils';

const currencyLabel = {
  CNY: 'CNY 人民币',
  USD: 'USD 美元',
} as const satisfies Record<Currency, string>;
const currencySymbol = { CNY: '¥', USD: '$' } as const satisfies Record<
  Currency,
  string
>;

type CopySource = Extract<RatesChoice, { kind: 'copy' }>['source'];
type PortalState =
  | { status: 'pending' }
  | { status: 'created'; response: AdminPortalAccountCreateResponse }
  | { status: 'failed'; message: string };
type Created = {
  tenant: AdminTenantCreateResponse['tenant'];
  rates: string;
  portalRequest: AdminPortalAccountCreateRequest;
  portal: PortalState;
};

function Field({
  label,
  required = false,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: React.ReactNode;
  error: string | undefined;
  className?: string;
  children: (props: {
    id: string;
    'aria-invalid': true | undefined;
    'aria-describedby': string | undefined;
    'aria-required': true | undefined;
  }) => React.ReactNode;
}) {
  const id = useId();
  const messageId = `${id}-message`;
  const hintId = `${id}-hint`;
  const describedBy =
    [error ? messageId : null, hint ? hintId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return (
    <div className={cn('flex flex-col gap-1.5 text-sm font-medium', className)}>
      <label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden className="text-err">
            {' '}
            *
          </span>
        ) : null}
      </label>
      {children({
        id,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required || undefined,
      })}
      {error ? (
        <span id={messageId} className="text-xs font-normal text-err">
          {error}
        </span>
      ) : null}
      {hint ? (
        <span
          id={hintId}
          className="text-xs leading-normal font-normal text-muted-foreground"
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

const invalidClass = (error: string | undefined) =>
  error ? 'border-err focus-visible:ring-err/30' : undefined;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="grid gap-3.5 border-t border-border py-6 md:grid-cols-[240px_1fr] md:gap-8"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <span className="text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </span>
      </div>
      <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">{children}</div>
    </section>
  );
}

function MoneyInput({
  currency,
  value,
  onChange,
  placeholder,
  error,
  ...aria
}: {
  currency: Currency;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error: string | undefined;
  id: string;
  'aria-invalid': true | undefined;
  'aria-describedby': string | undefined;
  'aria-required': true | undefined;
}) {
  return (
    <div
      className={cn(
        'flex h-11 items-center overflow-hidden rounded-lg border border-input font-normal focus-within:ring-[3px] focus-within:ring-ring/50 md:h-10',
        error && 'border-err',
      )}
    >
      <span
        aria-hidden
        className="flex h-full items-center border-r border-input px-3 text-muted-foreground"
      >
        {currencySymbol[currency]}
      </span>
      <input
        {...aria}
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent px-3 text-right text-base tabular-nums outline-none placeholder:text-muted-foreground md:text-sm"
      />
    </div>
  );
}

function CurrencyChoice({
  value,
  onChange,
}: {
  value: Currency;
  onChange: (currency: Currency) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span id="currency-label">
        币种
        <span aria-hidden className="text-err">
          {' '}
          *
        </span>
      </span>
      <div
        role="radiogroup"
        aria-labelledby="currency-label"
        className="grid h-11 grid-cols-2 gap-0.5 rounded-lg bg-muted p-[3px] md:h-10"
      >
        {currencySchema.options.map((currency) => (
          <button
            key={currency}
            type="button"
            role="radio"
            aria-checked={value === currency}
            onClick={() => onChange(currency)}
            className={cn(
              'rounded-md text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              value === currency
                ? 'bg-background font-semibold text-primary shadow-[0_1px_2px_rgba(0,0,0,.12)]'
                : 'font-normal text-muted-foreground',
            )}
          >
            {currencyLabel[currency]}
          </button>
        ))}
      </div>
      <span className="text-xs font-normal text-muted-foreground">
        创建后不可修改
      </span>
    </div>
  );
}

/** 通知邮箱：回车、逗号或失焦时加入列表；小写去重后显示；为空时提示提醒无法送达。 */
function RecipientsInput({
  emails,
  error,
  onChange,
}: {
  emails: string[];
  error: string | undefined;
  onChange: (emails: string[]) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const commit = () => {
    if (!draft.trim()) return;
    const next = addRecipients(emails, draft);
    onChange(next.emails);
    setNotice(next.notice);
    setDraft('');
  };
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium md:col-span-2">
      <label htmlFor={id}>通知邮箱</label>
      <span className="-mt-1 text-xs font-normal text-muted-foreground">
        可添加多个，余额不足和停机通知会发送到这些邮箱
      </span>
      <div
        className={cn(
          'flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-input px-2 py-1.5 font-normal focus-within:ring-[3px] focus-within:ring-ring/50',
          error && 'border-err',
        )}
      >
        <ul aria-label="已添加的通知邮箱" className="contents">
          {emails.map((email) => (
            <li
              key={email}
              className="flex h-7 items-center gap-1.5 rounded-md bg-muted pr-1.5 pl-2.5 text-[13px]"
            >
              {email}
              <button
                type="button"
                aria-label={`移除 ${email}`}
                onClick={() =>
                  onChange(emails.filter((item) => item !== email))
                }
                className="text-[11px] text-muted-foreground"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
        <input
          id={id}
          type="email"
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-messages`}
          placeholder="输入邮箱后按回车添加"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Backspace' && !draft && emails.length)
              onChange(emails.slice(0, -1));
          }}
          className="h-8 min-w-[180px] flex-1 bg-transparent px-1.5 text-base outline-none placeholder:text-[13px] placeholder:text-muted-foreground md:text-sm"
        />
      </div>
      <div id={`${id}-messages`} className="flex flex-col gap-1">
        {error ? (
          <span className="text-xs font-normal text-err">{error}</span>
        ) : null}
        {notice ? (
          <span className="text-xs font-normal text-muted-foreground">
            {notice}
          </span>
        ) : null}
        {emails.length === 0 ? (
          <span role="status" className="text-xs font-normal text-warn">
            未配置收件人，余额提醒无法送达
          </span>
        ) : null}
      </div>
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
  onFile,
  onError,
}: {
  file: { filename: string } | null;
  onFile: (file: { filename: string; contentBase64: string } | null) => void;
  onError: (message: string | null) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <label htmlFor={id}>CSV 文件</label>
      <input
        id={id}
        type="file"
        accept=".csv,text/csv"
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (!selected) return onFile(null);
          if (csvTooLarge(selected.size)) {
            onFile(null);
            onError('文件超过 2 MB 上限');
            return;
          }
          onError(null);
          void fileToBase64(selected).then((contentBase64) =>
            onFile({ filename: selected.name, contentBase64 }),
          );
        }}
        className="text-[13px] font-normal file:mr-3 file:h-9 file:rounded-lg file:border file:border-input file:bg-transparent file:px-3 file:text-sm file:text-foreground"
      />
      <span className="text-xs font-normal text-muted-foreground">
        {file
          ? `已选择 ${file.filename}`
          : '整表导入；首行可为表头 prefix,country,rate 或 前缀,国家,费率；支持 UTF-8 与 GBK'}
      </span>
    </div>
  );
}

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
  const [tenantId, setTenantId] = useState(source?.tenantId ?? '');
  const tenants = useQuery(
    apiQuery('adminTenants', { query: { currency, pageSize: 100 } }),
  );
  const rates = useQuery({
    ...apiQuery('adminRates', { params: { tenantId } }),
    enabled: tenantId !== '',
  });
  const picked = tenants.data?.items.find((item) => item.id === tenantId);
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
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium md:col-span-2">
      <label htmlFor={id}>复制自</label>
      <select
        id={id}
        value={tenantId}
        disabled={!tenants.data}
        onChange={(event) => {
          setTenantId(event.target.value);
          onChange(null);
        }}
        className="h-11 rounded-lg border border-input bg-background px-3 text-base font-normal outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-10 md:text-sm"
      >
        <option value="">
          {tenants.isError
            ? '租户列表加载失败'
            : tenants.data
              ? '选择租户'
              : '加载中…'}
        </option>
        {tenants.data?.items.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.code} {tenant.name}
          </option>
        ))}
      </select>
      <span className="text-xs font-normal text-muted-foreground">
        {rates.isError
          ? '该租户的费率表加载失败，请重新选择'
          : current && picked
            ? `当前生效版本 ${current.entries.length} 条费率`
            : `仅显示同币种（${currency}）的租户`}
      </span>
    </div>
  );
}

function CsvErrors({ rows }: { rows: AdminCsvRowError[] }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-err-border bg-err-soft px-3.5 py-3 text-[13px] text-err md:col-span-2"
    >
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
    </div>
  );
}

function PortalResult({
  created,
  retrying,
  onRetry,
}: {
  created: Created;
  retrying: boolean;
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
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-[10px] border border-err-border bg-err-soft px-4 py-3.5 text-err"
      >
        <span className="text-sm font-semibold">
          门户账号 {portalRequest.email} 未开通
        </span>
        <span className="text-[13px]">{portal.message}</span>
        <span className="text-xs text-foreground">
          租户已创建。可以重试，或稍后在租户详情「门户账号」标签页开通。
        </span>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={retrying}
          onClick={onRetry}
        >
          重试开通
        </Button>
      </div>
    );
  const { response } = portal;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border px-4 py-3.5">
      <span className="text-sm font-semibold">
        门户账号 {response.account.email} 已开通
      </span>
      {response.passwordSource === 'generated' ? (
        <>
          <CopyField value={response.temporaryPassword} label="临时密码" />
          <div className="flex flex-col gap-0.5 rounded-lg border border-warn-border bg-warn-soft px-3 py-2.5 text-[13px] leading-normal text-warn">
            <span className="font-semibold">
              只显示一次，关闭后无法再次查看
            </span>
            <span>
              请立即复制并通过安全渠道发给客户，客户首次登录后需修改密码。
            </span>
          </div>
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
  retrying,
  onRetryPortal,
  onContinue,
  onView,
}: {
  created: Created;
  retrying: boolean;
  onRetryPortal: () => void;
  onContinue: () => void;
  onView: () => void;
}) {
  const { tenant } = created;
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
      <div className="flex flex-col gap-2.5 rounded-[10px] border border-warn-border bg-warn-soft px-4 py-3.5">
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
      </div>
      <PortalResult
        created={created}
        retrying={retrying}
        onRetry={onRetryPortal}
      />
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onContinue}>
          继续新建
        </Button>
        <Button className="h-12 md:h-9" onClick={onView}>
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
  // 临时密码只留在组件状态里：结果不进入查询缓存，卸载后即清除。
  const createPortal = useMutation({
    gcTime: 0,
    mutationFn: (input: {
      tenantId: string;
      body: AdminPortalAccountCreateRequest;
    }) =>
      callApi('adminPortalAccountCreate', {
        params: { tenantId: input.tenantId },
        body: input.body,
      }),
  });

  const update = (patch: Partial<TenantForm>) =>
    setForm((current) => ({ ...current, ...patch }));
  const setRates = (rates: RatesChoice) => {
    setCsvRows(null);
    setErrors((current) => {
      const next = { ...current };
      delete next.rates;
      return next;
    });
    update({ rates });
  };

  async function openPortal(
    tenantId: string,
    body: AdminPortalAccountCreateRequest,
  ) {
    setCreated(
      (current) => current && { ...current, portal: { status: 'pending' } },
    );
    try {
      const response = await createPortal.mutateAsync({ tenantId, body });
      setCreated(
        (current) =>
          current && { ...current, portal: { status: 'created', response } },
      );
    } catch (error) {
      const message =
        error instanceof ApiRequestError && error.status === 0
          ? '网络中断，无法确认是否已开通。请先在租户详情「门户账号」标签页查看，不要重复开通。'
          : problemNotice(apiProblem(error)).title;
      setCreated(
        (current) =>
          current && { ...current, portal: { status: 'failed', message } },
      );
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
    if (error instanceof ApiRequestError && error.status === 0) {
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

  const codeHint = normalizedCode(form.code);
  const pending = createTenant.isPending;

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
          <span className="-mt-3 pb-5 text-[13px] text-muted-foreground">
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

          <Section title="基本信息" description="编码和币种创建后不可修改">
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
          </Section>

          <Section
            title="额度与提醒"
            description="余额 + 透支额度用完后停机；余额低于阈值时发邮件提醒"
          >
            <Field
              label="透支额度"
              required
              error={errors.overdraftLimit}
              hint={
                form.overdraftEdited
                  ? undefined
                  : `默认 CNY 100 / USD 15，切换币种时自动更新`
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
            <RecipientsInput
              emails={form.emails}
              error={errors.emails}
              onChange={(emails) => update({ emails })}
            />
          </Section>

          <Section title="联系信息" description="可选，仅内部可见">
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
                <textarea
                  {...props}
                  maxLength={2000}
                  placeholder="选填"
                  value={form.remark}
                  onChange={(event) => update({ remark: event.target.value })}
                  className="min-h-16 rounded-lg border border-input bg-transparent px-3 py-2.5 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
                />
              )}
            </Field>
          </Section>

          <Section
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
          </Section>

          <Section title="费率表" description="没有费率的前缀，呼叫会被拒绝">
            <div
              role="radiogroup"
              aria-label="初始费率表"
              className="grid gap-2.5 md:col-span-2 md:grid-cols-3"
            >
              {rateOptions.map((option) => {
                const selected = form.rates.kind === option.kind;
                return (
                  <button
                    key={option.kind}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setRates(
                        option.kind === 'blank'
                          ? { kind: 'blank' }
                          : option.kind === 'csv'
                            ? { kind: 'csv', file: null }
                            : { kind: 'copy', source: null },
                      )
                    }
                    className={cn(
                      'flex items-start gap-2.5 rounded-lg border p-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                      selected
                        ? 'border-[1.5px] border-primary bg-brand-soft'
                        : 'border-input',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-0.5 size-4 shrink-0 rounded-full',
                        selected
                          ? 'border-[5px] border-primary'
                          : 'border-[1.5px] border-input',
                      )}
                    />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">
                        {option.label}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {option.sub}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            {form.rates.kind === 'csv' ? (
              <CsvPicker
                file={form.rates.file}
                onFile={(file) => setRates({ kind: 'csv', file })}
                onError={(message) =>
                  setErrors((current) =>
                    message ? { ...current, rates: message } : current,
                  )
                }
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
          </Section>

          <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background pt-4 pb-6">
            <Link
              to="/admin/tenants"
              className={cn(
                buttonVariants({ variant: 'outline' }),
                'h-12 flex-1 md:h-9 md:flex-none',
              )}
            >
              取消
            </Link>
            <Button
              type="submit"
              disabled={pending}
              className="h-12 flex-1 text-base md:h-9 md:flex-none md:text-sm"
            >
              {pending ? '创建中…' : '创建租户'}
            </Button>
          </div>
        </form>
        {created ? (
          <CreatedDialog
            created={created}
            retrying={createPortal.isPending}
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
