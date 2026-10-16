import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  adminTenantEditRequestSchema,
  type AdminTenantDetailResponse,
  type AdminTenantEditRequest,
  type Identity,
} from '@fs-billing/shared';
import { Field, invalidClass } from '../../components/admin/form-fields';
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
import { cn } from '../../lib/utils';

type EditField = keyof AdminTenantEditRequest;

const limits = {
  name: 200,
  contactName: 200,
  contactPhone: 100,
  remark: 2000,
} as const satisfies Record<EditField, number>;

function localErrors(form: AdminTenantEditRequest) {
  const errors: Partial<Record<EditField, string>> = {};
  if (!form.name.trim()) errors.name = '请输入租户名称';
  for (const field of Object.keys(limits) as EditField[])
    if (!errors[field] && form[field].trim().length > limits[field])
      errors[field] = `最多 ${limits[field]} 个字符`;
  return errors;
}

function EditForm({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const navigate = useNavigate();
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
    const found = localErrors(form);
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
          placeholder={required ? undefined : '选填'}
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
      aria-label="编辑租户"
      onSubmit={(event) => {
        event.preventDefault();
        if (!edit.isPending) void submit();
      }}
      className="flex max-w-[1020px] flex-col"
    >
      <span className="-mt-3 pb-5 text-[13px] text-muted-foreground">
        带 <span className="text-err">*</span> 为必填
      </span>
      {unchanged ? (
        <div
          role="status"
          className="mb-4 rounded-[10px] border border-border bg-muted px-3.5 py-2.5 text-sm text-muted-foreground"
        >
          内容没有变化，未记入操作日志
        </div>
      ) : null}
      {edit.error && apiProblem(edit.error).kind !== 'validation' ? (
        <div className="mb-4">
          <ProblemAlert
            error={edit.error}
            networkMessage="无法确认是否已保存，请返回租户详情查看后再修改。"
          />
        </div>
      ) : null}
      <section
        aria-label="基本信息"
        className="grid gap-3.5 border-t border-border py-6 md:grid-cols-[240px_1fr] md:gap-8"
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-semibold">基本信息</h2>
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            编码和币种创建后不可修改
          </span>
        </div>
        <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            <span>
              租户编码
              <RequiredMark />
              <LockedHint className="ml-2" />
            </span>
            <span className="flex h-11 items-center rounded-lg border border-input bg-muted px-3 font-mono font-normal md:h-10">
              {tenant.code}
            </span>
            <span className="text-xs leading-normal font-normal text-muted-foreground">
              字母和数字，须与 FreeSWITCH 中的{' '}
              <span className="font-mono text-foreground">billing_tenant</span>{' '}
              一致
            </span>
          </div>
          {text('name', '租户名称', true)}
          <div className="flex flex-col gap-1.5 text-sm font-medium">
            <span>
              币种
              <RequiredMark />
            </span>
            <span className="flex h-11 items-center justify-between gap-2 rounded-lg border border-input bg-muted px-3 font-normal md:h-10">
              {tenant.currency}
              <LockedHint />
            </span>
          </div>
        </div>
      </section>
      <section
        aria-label="联系信息"
        className="grid gap-3.5 border-t border-border py-6 md:grid-cols-[240px_1fr] md:gap-8"
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-semibold">联系信息</h2>
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            可选，仅内部可见
          </span>
        </div>
        <div className="grid gap-x-5 gap-y-4 md:grid-cols-2">
          {text('contactName', '联系人')}
          {text('contactPhone', '电话')}
          <Field label="备注" error={errors.remark} className="md:col-span-2">
            {(props) => (
              <textarea
                {...props}
                rows={3}
                maxLength={limits.remark}
                placeholder="选填"
                value={form.remark}
                onChange={(event) => update({ remark: event.target.value })}
                className="resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
              />
            )}
          </Field>
        </div>
      </section>
      <p className="m-0 border-t border-border py-4 text-[13px] text-muted-foreground">
        透支额度、余额提醒和通知邮箱请在租户详情的「设置」标签页修改；门户账号和费率表请在「门户账号」「费率」标签页中管理。
      </p>
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 border-t border-border bg-background pt-4 pb-6 md:flex-row md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={back}>
          取消
        </Button>
        <Button type="submit" className="h-12 md:h-9" disabled={edit.isPending}>
          保存修改
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
  return (
    <span
      className={cn('text-xs font-normal text-muted-foreground', className)}
    >
      <span aria-hidden>🔒 </span>创建后不可修改
    </span>
  );
}

/** 编辑租户（设计稿第二批 5a）：名称与联系信息；编码、币种只读。 */
export function TenantEditPage({ identity }: { identity: Identity }) {
  const { tenantId } = useParams({ from: '/admin/tenants/$tenantId/edit' });
  const detail = useQuery(
    apiQuery('adminTenantDetail', { params: { tenantId } }),
  );
  const tenant = detail.data;
  return (
    <AppShell
      identity={identity}
      title="编辑租户"
      crumb={
        <>
          <Link to="/admin/tenants" className="text-primary">
            租户
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
          / <span className="text-foreground">编辑</span>
        </>
      }
      activeNav="租户"
    >
      <PageBody title="编辑租户">
        {tenant ? (
          <EditForm tenant={tenant} />
        ) : detail.isError ? (
          <QueryError
            title="租户详情加载失败"
            error={detail.error}
            retrying={detail.isFetching}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <div
            aria-busy
            aria-label="租户详情加载中"
            className="h-[240px] animate-pulse rounded-xl bg-skeleton"
          />
        )}
      </PageBody>
    </AppShell>
  );
}
