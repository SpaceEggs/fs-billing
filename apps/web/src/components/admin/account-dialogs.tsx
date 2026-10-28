import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { cn } from '../../lib/utils';
import { Alert } from '../ui/alert';
import { send, useCredentialMutation } from '../../lib/admin-api';
import { ApiRequestError } from '../../lib/api';
import { SecretField } from '../copy-field';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert } from './problem-alert';

export type AccountAudience = 'admin' | 'portal';
export type StatusAction = 'disable' | 'enable';

export type AccountTarget = {
  audience: AccountAudience;
  id: string;
  /** 管理员姓名；门户账号没有姓名，用登录邮箱。 */
  name: string;
  email: string;
};

export type StatusChange = {
  target: AccountTarget;
  action: StatusAction;
  /** 服务端返回 auditId 为 null：账号已是目标状态，没有变更。 */
  changed: boolean;
};

const listKeys = {
  admin: ['api', 'adminAccounts'],
  portal: ['api', 'adminPortalAccounts'],
} as const satisfies Record<AccountAudience, readonly unknown[]>;

export function refreshAccounts(
  queryClient: ReturnType<typeof useQueryClient>,
  audience: AccountAudience,
) {
  return queryClient.invalidateQueries({ queryKey: listKeys[audience] });
}

const dialogActions =
  'flex flex-col-reverse gap-2 md:flex-row md:justify-end [&>button]:h-12 md:[&>button]:h-9';

function Heading({ title, sub }: { title: string; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
      {sub ? (
        <span className="text-sm leading-relaxed text-muted-foreground">
          {sub}
        </span>
      ) : null}
    </div>
  );
}

/** 只显示一次的临时密码（第三批系统与账号 2d/2h、租户详情 2d）。 */
export function TemporaryPassword({
  value,
  recipient,
  logged,
}: {
  value: string;
  /** “对方”或“客户”。 */
  recipient: string;
  logged: string;
}) {
  return (
    <>
      <SecretField value={value} label="临时密码" />
      <Alert variant="warning">
        <span className="font-semibold">关闭后无法再次查看</span>
        <span>
          请立即复制并通过安全渠道发给{recipient}，{recipient}
          首次登录后需修改密码。{logged}
        </span>
      </Alert>
    </>
  );
}

const resetCopy = {
  admin: {
    operation: 'resetAdminPassword',
    recipient: '对方',
    confirm: (t: AccountTarget, self: boolean) =>
      self
        ? '将生成新的临时密码，原密码立即失效，你的所有登录都会退出。之后需用临时密码重新登录并修改密码。'
        : `将生成新的临时密码，原密码立即失效，${t.name}的所有登录都会退出。`,
    done: (t: AccountTarget) => `已为 ${t.name} 生成临时密码`,
    effect: (t: AccountTarget) =>
      `${t.email} · 原密码已失效，${t.name}的所有登录已退出`,
  },
  portal: {
    operation: 'resetPortalAccountPassword',
    recipient: '客户',
    confirm: () =>
      '将生成新的临时密码，原密码立即失效，客户所有设备上的登录都会退出。',
    done: () => '已生成临时密码',
    effect: (t: AccountTarget) =>
      `${t.email} · 原密码已失效，客户所有设备上的登录已退出`,
  },
} as const;

/**
 * 重置密码：先确认，成功后显示一次临时密码。结果页不能用 Esc 或遮罩关闭，只能点“我已复制，关闭”。
 * 临时密码只在本组件状态里，关闭即丢弃。
 */
export function ResetPasswordDialog({
  target,
  self = false,
  onClose,
}: {
  target: AccountTarget;
  self?: boolean;
  onClose: () => void;
}) {
  const copy = resetCopy[target.audience];
  const reset = useCredentialMutation(copy.operation);
  const [password, setPassword] = useState<string | null>(null);

  async function confirm() {
    try {
      const response = await reset.submit({ params: { id: target.id } });
      if (response) setPassword(response.temporaryPassword);
    } catch {
      // 失败说明由 reset.error 显示。
    }
  }

  if (password !== null)
    return (
      <ModalDialog
        open
        title={copy.done(target)}
        description={copy.effect(target)}
      >
        <Heading title={copy.done(target)} sub={copy.effect(target)} />
        <TemporaryPassword
          value={password}
          recipient={copy.recipient}
          logged="本次重置已记入操作日志。"
        />
        <div className={dialogActions}>
          <Button variant="outline" onClick={onClose}>
            我已复制，关闭
          </Button>
        </div>
      </ModalDialog>
    );

  const title =
    target.audience === 'admin'
      ? `重置 ${target.name} 的密码？`
      : '重置门户账号密码？';
  return (
    <ModalDialog
      open
      {...(reset.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={title}
      description={copy.confirm(target, self)}
    >
      <Heading title={title} sub={target.email} />
      <p className="m-0 text-sm leading-relaxed">
        {copy.confirm(target, self)}
        临时密码只显示一次，{copy.recipient}
        登录后需修改密码。重置记入操作日志。
      </p>
      {reset.error ? (
        <ProblemAlert
          error={reset.error}
          networkMessage="无法确认是否已重置，原密码可能已失效。请再次重置以生成新的临时密码。"
        />
      ) : null}
      <div className={dialogActions}>
        <Button variant="outline" disabled={reset.isPending} onClick={onClose}>
          取消
        </Button>
        <Button disabled={reset.isPending} onClick={() => void confirm()}>
          {reset.isPending ? '正在重置…' : '重置密码'}
        </Button>
      </div>
    </ModalDialog>
  );
}

type StatusCopy = {
  title: (t: AccountTarget) => string;
  body: (t: AccountTarget) => string;
  note?: { title: string; body: string; tone: 'error' | 'brand' };
  confirm: string;
};

const statusCopy = {
  admin: {
    disable: {
      title: (t) => `停用管理员 ${t.name}？`,
      body: (t) =>
        `停用后${t.name}会立即退出登录，且无法再登录管理后台。之前的操作记录保留，可随时重新启用。停用操作记入操作日志。`,
      confirm: '停用',
    },
    enable: {
      title: (t) => `启用管理员 ${t.name}？`,
      body: (t) =>
        `启用后${t.name}可以重新登录管理后台，停用时退出的登录不会恢复。启用操作记入操作日志。`,
      confirm: '启用',
    },
  },
  portal: {
    disable: {
      title: () => '停用门户账号？',
      body: (t) => `${t.email} 将立即退出登录，停用后客户无法登录客户门户。`,
      note: {
        title: '不影响呼叫和计费',
        body: '租户的呼叫、计费和余额不受影响；如需暂停呼叫，请使用页面右上角的「停用」。可随时重新启用。停用和启用均记入操作日志。',
        tone: 'error',
      },
      confirm: '停用账号',
    },
    enable: {
      title: () => '启用门户账号？',
      body: (t) =>
        `${t.email} 可重新登录客户门户，停用时退出的登录不会恢复。启用记入操作日志。`,
      confirm: '启用账号',
    },
  },
} as const satisfies Record<AccountAudience, Record<StatusAction, StatusCopy>>;

const statusOperations = {
  admin: { disable: 'adminAccountDisable', enable: 'adminAccountEnable' },
  portal: {
    disable: 'adminPortalAccountDisable',
    enable: 'adminPortalAccountEnable',
  },
} as const;

/** 停用被服务端拒绝时（第三批系统与账号 2f）的说明。 */
const disableRefusals = {
  LAST_ADMIN:
    '系统至少需要保留一位启用的管理员。请先新增或启用其他管理员，再执行此操作。',
  SELF_DISABLE: '不能停用自己的账号。如需停用，请由其他管理员操作。',
} as const;

function refusal(error: unknown) {
  if (!(error instanceof ApiRequestError)) return null;
  const code = error.code;
  return code === 'LAST_ADMIN' || code === 'SELF_DISABLE'
    ? disableRefusals[code]
    : null;
}

/** 停用、启用管理员或门户账号的确认。门户账号停用只影响登录，不影响呼叫。 */
export function AccountStatusDialog({
  target,
  action,
  extraNote,
  onClose,
  onDone,
}: {
  target: AccountTarget;
  action: StatusAction;
  /** 额外说明，例如租户已停用时启用门户账号仍无法登录。 */
  extraNote?: string | undefined;
  onClose: () => void;
  onDone: (change: StatusChange) => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      send(statusOperations[target.audience][action], {
        params: { id: target.id },
      }),
    onSettled: () => refreshAccounts(queryClient, target.audience),
  });
  const copy: StatusCopy = statusCopy[target.audience][action];
  const refused = refusal(mutation.error);

  async function confirm() {
    try {
      const result = await mutation.mutateAsync();
      onDone({ target, action, changed: result.auditId !== null });
    } catch {
      // 失败说明由 mutation.error 显示。
    }
  }

  if (refused)
    return (
      <ModalDialog
        open
        onOpenChange={(open) => open || onClose()}
        title="无法停用"
        description={refused}
      >
        <Heading title="无法停用" sub={refused} />
        <div className={dialogActions}>
          <Button onClick={onClose}>知道了</Button>
        </div>
      </ModalDialog>
    );

  return (
    <ModalDialog
      open
      {...(mutation.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={copy.title(target)}
      description={copy.body(target)}
    >
      <Heading title={copy.title(target)} sub={copy.body(target)} />
      {copy.note ? (
        <Alert variant={copy.note.tone} role="note" className="text-foreground">
          <span className="font-semibold">{copy.note.title}</span>
          <span>{copy.note.body}</span>
        </Alert>
      ) : null}
      {extraNote ? (
        <Alert variant="muted" role="note">
          {extraNote}
        </Alert>
      ) : null}
      {mutation.error ? (
        <ProblemAlert
          error={mutation.error}
          networkMessage="无法确认是否已生效，列表已刷新，请查看账号状态后再操作。"
          onRefresh={() => {
            void refreshAccounts(queryClient, target.audience);
            onClose();
          }}
        />
      ) : null}
      <div className={dialogActions}>
        <Button
          variant="outline"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          取消
        </Button>
        <Button
          className={
            action === 'disable' ? 'bg-destructive text-white' : undefined
          }
          disabled={mutation.isPending}
          onClick={() => void confirm()}
        >
          {copy.confirm}
        </Button>
      </div>
    </ModalDialog>
  );
}

const noticeCopy = {
  admin: {
    disable: {
      changed: (t: AccountTarget) => `已停用管理员 ${t.name}，已记入操作日志`,
      same: (t: AccountTarget) => `${t.name} 已是停用状态，没有变更`,
    },
    enable: {
      changed: (t: AccountTarget) => `已启用管理员 ${t.name}，已记入操作日志`,
      same: (t: AccountTarget) => `${t.name} 已是启用状态，没有变更`,
    },
  },
  portal: {
    disable: {
      changed: () => '门户账号已停用，已记入操作日志',
      same: () => '门户账号已是停用状态，没有变更',
    },
    enable: {
      changed: () => '门户账号已启用，已记入操作日志',
      same: () => '门户账号已是启用状态，没有变更',
    },
  },
} as const;

export function StatusChangeNotice({ change }: { change: StatusChange }) {
  const text = noticeCopy[change.target.audience][change.action][
    change.changed ? 'changed' : 'same'
  ](change.target);
  return (
    <Alert
      variant={change.changed ? 'success' : 'muted'}
      role="status"
      className={cn('px-3.5', !change.changed && 'text-muted-foreground')}
    >
      {text}
    </Alert>
  );
}
