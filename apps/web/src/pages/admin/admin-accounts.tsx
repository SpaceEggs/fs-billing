import { useId, useState } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type {
  AdminAccount,
  AdminAccountCreateResponse,
  AdminStatus,
  Identity,
} from '@fs-billing/shared';
import {
  AccountStatusDialog,
  ResetPasswordDialog,
  StatusChangeNotice,
  TemporaryPassword,
  refreshAccounts,
  type AccountTarget,
  type StatusAction,
  type StatusChange,
} from '../../components/admin/account-dialogs';
import { Field, invalidClass } from '../../components/admin/form-fields';
import { ProblemAlert } from '../../components/admin/problem-alert';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime } from '../../components/data-format';
import { Pagination } from '../../components/pagination';
import { QueryError } from '../../components/query-error';
import { SearchBox } from '../../components/search-box';
import { Button } from '../../components/ui/button';
import { ModalDialog } from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { apiQuery, useCredentialMutation } from '../../lib/admin-api';
import {
  buildAdminCreate,
  outcomeUnknown,
  serverAccountErrors,
  type AccountFieldErrors,
} from '../../lib/accounts';
import type { AdminAccountsSearch } from '../../lib/admin-search';
import { apiProblem } from '../../lib/api-problem';
import { cn } from '../../lib/utils';

export const adminPageSize = 25;

const statusTag = {
  active: { label: '启用', className: 'border-ok-border bg-ok-soft text-ok' },
  disabled: {
    label: '已停用',
    className: 'border-border bg-muted text-muted-foreground',
  },
} as const satisfies Record<AdminStatus, { label: string; className: string }>;

const selfDisableHint = '不能停用自己的账号';

type Action =
  | { kind: 'create' }
  | { kind: 'menu'; account: AdminAccount }
  | { kind: 'reset'; account: AdminAccount }
  | { kind: 'status'; account: AdminAccount; action: StatusAction };

const toTarget = (account: AdminAccount): AccountTarget => ({
  audience: 'admin',
  id: account.id,
  name: account.name,
  email: account.email,
});

const statusAction = (account: AdminAccount): StatusAction =>
  account.status === 'active' ? 'disable' : 'enable';

function StatusTag({
  status,
  className,
}: {
  status: AdminStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center rounded-md border px-2 text-xs font-medium',
        statusTag[status].className,
        className,
      )}
    >
      {statusTag[status].label}
    </span>
  );
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold',
        className,
      )}
    >
      {Array.from(name)[0]}
    </span>
  );
}

function SelfMarker() {
  return (
    <span className="inline-flex h-5 items-center rounded-[5px] bg-brand-soft px-[7px] text-[11px] font-semibold text-primary">
      你
    </span>
  );
}

function LastLogin({ value }: { value: string | null }) {
  return value ? (
    <DateTime value={value} />
  ) : (
    <span className="text-muted-foreground">从未登录</span>
  );
}

/** 电脑行内的“停用 / 启用”；自己的行禁用并说明原因（设计稿 2a 悬停提示）。 */
function StatusLink({
  account,
  self,
  onClick,
}: {
  account: AdminAccount;
  self: boolean;
  onClick: () => void;
}) {
  const hintId = useId();
  const action = statusAction(account);
  const label = action === 'disable' ? '停用' : '启用';
  if (self)
    return (
      <span className="group relative inline-flex">
        <Button
          variant="ghost"
          size="sm"
          disabled
          aria-label={`${label} ${account.name}`}
          aria-describedby={hintId}
          className="px-1.5 text-muted-foreground"
        >
          {label}
        </Button>
        <span
          id={hintId}
          role="tooltip"
          className="pointer-events-none absolute right-0 bottom-full mb-1 hidden rounded-md bg-foreground px-2.5 py-1.5 text-xs whitespace-nowrap text-background group-hover:block"
        >
          {selfDisableHint}
        </span>
      </span>
    );
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`${label} ${account.name}`}
      onClick={onClick}
      className={cn(
        'px-1.5',
        action === 'disable' ? 'text-neg' : 'text-primary',
      )}
    >
      {label}
    </Button>
  );
}

function AdminTable({
  items,
  selfId,
  onAction,
}: {
  items: AdminAccount[];
  selfId: string;
  onAction: (action: Action) => void;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px] whitespace-nowrap">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">姓名</th>
            <th className="px-3 py-2.5 text-left font-medium">登录邮箱</th>
            <th className="px-3 py-2.5 text-left font-medium">状态</th>
            <th className="px-3 py-2.5 text-left font-medium">最后登录时间</th>
            <th className="px-4 py-2.5 text-right font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((account) => {
            const self = account.id === selfId;
            return (
              <tr key={account.id} className="border-t border-border">
                <td className="px-4 py-3">
                  <span className="flex items-center gap-2.5">
                    <Avatar name={account.name} />
                    <span className="text-sm font-medium">{account.name}</span>
                    {self ? <SelfMarker /> : null}
                  </span>
                </td>
                <td className="px-3 py-3">{account.email}</td>
                <td className="px-3 py-3">
                  <StatusTag status={account.status} />
                </td>
                <td
                  className={cn(
                    'px-3 py-3 tabular-nums',
                    account.status === 'disabled' && 'text-muted-foreground',
                  )}
                >
                  <LastLogin value={account.lastLoginAt} />
                </td>
                <td className="px-4 py-1.5">
                  <span className="flex justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`重置 ${account.name} 的密码`}
                      onClick={() => onAction({ kind: 'reset', account })}
                      className="px-1.5 text-primary"
                    >
                      重置密码
                    </Button>
                    <StatusLink
                      account={account}
                      self={self}
                      onClick={() =>
                        onAction({
                          kind: 'status',
                          account,
                          action: statusAction(account),
                        })
                      }
                    />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdminCards({
  items,
  selfId,
  onAction,
}: {
  items: AdminAccount[];
  selfId: string;
  onAction: (action: Action) => void;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
      {items.map((account) => (
        <li
          key={account.id}
          className="flex items-center gap-3 rounded-xl border border-border py-3.5 pr-1 pl-3.5"
        >
          <Avatar name={account.name} className="size-9 text-sm" />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[15px] font-semibold">{account.name}</span>
              {account.id === selfId ? <SelfMarker /> : null}
              <StatusTag
                status={account.status}
                className="h-5 px-[7px] text-[11px]"
              />
            </span>
            <span className="truncate text-[13px] text-muted-foreground">
              {account.email}
            </span>
            <span className="text-xs text-muted-foreground tabular-nums">
              最后登录 <LastLogin value={account.lastLoginAt} />
            </span>
          </span>
          <Button
            variant="ghost"
            aria-label={`${account.name} 的操作`}
            onClick={() => onAction({ kind: 'menu', account })}
            className="size-11 text-lg text-muted-foreground"
          >
            ⋯
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** 手机端每行的操作（设计稿 2j）：自己的“停用”不可用。 */
function ActionSheet({
  account,
  self,
  onAction,
  onClose,
}: {
  account: AdminAccount;
  self: boolean;
  onAction: (action: Action) => void;
  onClose: () => void;
}) {
  const action = statusAction(account);
  const label = action === 'disable' ? '停用' : '启用';
  const title = `${account.name} 的操作`;
  return (
    <ModalDialog open onOpenChange={(open) => open || onClose()} title={title}>
      <div className="flex items-center gap-3 border-b border-border pb-3.5">
        <Avatar name={account.name} className="size-10 text-[15px]" />
        <span className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold">
            {account.name}
            {self ? '（你）' : null}
          </span>
          <span className="text-xs text-muted-foreground">{account.email}</span>
        </span>
      </div>
      <div className="flex flex-col">
        <Button
          variant="ghost"
          className="h-12 justify-start border-b border-border px-0 text-base font-normal"
          onClick={() => onAction({ kind: 'reset', account })}
        >
          重置密码
        </Button>
        <Button
          variant="ghost"
          disabled={self}
          className={cn(
            'h-auto min-h-12 flex-col items-start gap-1 px-0 py-3 text-base font-normal',
            !self && (action === 'disable' ? 'text-neg' : 'text-primary'),
          )}
          onClick={() => onAction({ kind: 'status', account, action })}
        >
          {label}
          {self ? (
            <span className="text-[13px] text-muted-foreground">
              {selfDisableHint}
            </span>
          ) : null}
        </Button>
      </div>
    </ModalDialog>
  );
}

/**
 * 新增管理员（设计稿 2c/2g）：成功后在同一对话框显示一次临时密码。
 * 创建没有可重放的响应，不自动重试；结果未知时引导先在列表核实，已创建则用重置密码。
 */
export function CreateAdminDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const create = useCredentialMutation('adminAccountCreate');
  const [form, setForm] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState<AccountFieldErrors>({});
  const [created, setCreated] = useState<AdminAccountCreateResponse | null>(
    null,
  );

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

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const built = buildAdminCreate(form);
    if (!built.ok) {
      create.reset();
      setErrors(built.errors);
      return;
    }
    setErrors({});
    try {
      const response = await create.submit({ body: built.request });
      if (response) setCreated(response);
      void refreshAccounts(queryClient, 'admin');
    } catch (error) {
      if (outcomeUnknown(error)) void refreshAccounts(queryClient, 'admin');
    }
  }

  if (created)
    return (
      <ModalDialog
        open
        title={`已创建管理员 ${created.account.name}`}
        description={created.account.email}
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">
            已创建管理员 {created.account.name}
          </h2>
          <span className="text-[13px] text-muted-foreground">
            {created.account.email} · 拥有与你相同的全部权限
          </span>
        </div>
        <TemporaryPassword
          value={created.temporaryPassword}
          recipient="对方"
          logged="本次新增已记入操作日志。"
        />
        <div className="flex flex-col md:flex-row md:justify-end">
          <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
            我已复制，关闭
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
      title="新增管理员"
      description="新管理员拥有与你相同的全部权限"
      className="md:w-[480px]"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">新增管理员</h2>
        <span className="text-[13px] text-muted-foreground">
          新管理员拥有与你相同的全部权限
        </span>
      </div>
      <form
        aria-label="新增管理员"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Field label="姓名" required error={shown.name}>
          {(props) => (
            <Input
              {...props}
              autoComplete="off"
              maxLength={200}
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              className={invalidClass(shown.name)}
            />
          )}
        </Field>
        <Field label="登录邮箱" required error={shown.email}>
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
        <div className="rounded-lg bg-muted px-3 py-2.5 text-[13px] leading-normal text-muted-foreground">
          创建后系统生成临时密码，只显示一次。对方首次登录后需修改密码。新增操作记入操作日志。
        </div>
        {unknown ? (
          <div
            role="alert"
            className="flex flex-col gap-0.5 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
          >
            <span className="font-semibold">无法确认是否已创建</span>
            <span>
              请关闭后在列表中搜索该邮箱：若已创建，用「重置密码」生成新的临时密码，不要重复创建。
            </span>
          </div>
        ) : create.error && !emailTaken ? (
          <ProblemAlert error={create.error} />
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={create.isPending}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="submit"
            className="h-12 md:h-9"
            disabled={create.isPending}
          >
            {create.isPending ? '正在创建…' : '创建并生成临时密码'}
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

function LoadingRows() {
  return (
    <div
      aria-busy
      aria-label="管理员列表加载中"
      className="h-[180px] animate-pulse rounded-xl bg-skeleton"
    />
  );
}

/** 管理员（第三批系统与账号 2a–2j）：所有管理员同权；不能停用自己，至少保留一位启用。 */
export function AdminAccountsPage({ identity }: { identity: Identity }) {
  const search: AdminAccountsSearch = useSearch({ from: '/admin/admins' });
  const navigate = useNavigate({ from: '/admin/admins' });
  const page = search.page ?? 1;
  const list = useQuery({
    ...apiQuery('adminAccounts', {
      query: {
        ...(search.search ? { search: search.search } : {}),
        page,
        pageSize: adminPageSize,
      },
    }),
    placeholderData: keepPreviousData,
  });
  const active = useQuery(
    apiQuery('adminAccounts', { query: { status: 'active', pageSize: 1 } }),
  );
  const [action, setAction] = useState<Action | null>(null);
  const [change, setChange] = useState<StatusChange | null>(null);
  const close = () => setAction(null);
  const open = (next: Action) => {
    setChange(null);
    setAction(next);
  };
  const data = list.data;
  const meta = !data
    ? undefined
    : search.search
      ? `找到 ${data.pagination.total} 位`
      : `共 ${data.pagination.total} 位${
          active.data ? ` · ${active.data.pagination.total} 位启用` : ''
        }`;
  const selfId = identity.profileId;

  return (
    <AppShell
      identity={identity}
      title="管理员"
      crumb="管理员"
      activeNav="管理员"
    >
      <PageBody
        title="管理员"
        meta={meta}
        actions={
          <Button
            className="w-full md:w-auto"
            onClick={() => open({ kind: 'create' })}
          >
            ＋ 新增管理员
          </Button>
        }
      >
        <div
          role="note"
          className="rounded-lg border border-brand-border bg-brand-soft px-3 py-2.5 text-[13px]"
        >
          <span className="hidden md:inline">
            当前版本所有管理员权限相同，均可管理租户、费率、余额和其他管理员。不能停用自己，且至少保留一位启用的管理员。
          </span>
          <span className="md:hidden">
            所有管理员权限相同 · 至少保留一位启用的管理员
          </span>
        </div>
        <SearchBox
          label="搜索姓名或邮箱"
          value={search.search ?? ''}
          onChange={(value) =>
            void navigate({
              search: value ? { search: value } : {},
              replace: true,
            })
          }
          className="md:w-[280px]"
        />
        {change ? <StatusChangeNotice change={change} /> : null}
        {list.isError && !data ? (
          <QueryError
            title="管理员列表加载失败"
            error={list.error}
            retrying={list.isFetching}
            onRetry={() => void list.refetch()}
          />
        ) : !data ? (
          <LoadingRows />
        ) : data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border px-5 py-8 text-center">
            <span className="text-[15px] font-semibold">
              没有符合条件的管理员
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ search: {}, replace: true })}
            >
              清除搜索
            </Button>
          </div>
        ) : (
          <>
            <AdminTable items={data.items} selfId={selfId} onAction={open} />
            <AdminCards items={data.items} selfId={selfId} onAction={open} />
            <Pagination
              page={page}
              pageSize={adminPageSize}
              rowCount={data.pagination.total}
              onPage={(next) =>
                void navigate({
                  search: {
                    ...(search.search ? { search: search.search } : {}),
                    ...(next > 1 ? { page: next } : {}),
                  },
                })
              }
            />
          </>
        )}
      </PageBody>
      {action?.kind === 'create' ? <CreateAdminDialog onClose={close} /> : null}
      {action?.kind === 'menu' ? (
        <ActionSheet
          account={action.account}
          self={action.account.id === selfId}
          onAction={open}
          onClose={close}
        />
      ) : null}
      {action?.kind === 'reset' ? (
        <ResetPasswordDialog
          key={action.account.id}
          target={toTarget(action.account)}
          self={action.account.id === selfId}
          onClose={close}
        />
      ) : null}
      {action?.kind === 'status' ? (
        <AccountStatusDialog
          key={action.account.id}
          target={toTarget(action.account)}
          action={action.action}
          onClose={close}
          onDone={(done) => {
            close();
            setChange(done);
          }}
        />
      ) : null}
    </AppShell>
  );
}
