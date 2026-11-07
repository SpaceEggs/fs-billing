import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { translate, type Locale } from '@fs-billing/shared';
import { useLocale } from '../../i18n';
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
  const { t } = useTranslation(['admin']);
  return (
    <>
      <SecretField
        value={value}
        label={t('admin:accountDialogs.temporaryLabel')}
      />
      <Alert variant="warning">
        <span className="font-semibold">
          {t('admin:accountDialogs.oneTimeTitle')}
        </span>
        <span>
          {t('admin:accountDialogs.oneTimeBody', { recipient, logged })}
        </span>
      </Alert>
    </>
  );
}

const resetCopy = {
  admin: {
    operation: 'resetAdminPassword',
    recipient: 'admin:accountDialogs.adminRecipient',
    confirm: (locale: Locale, target: AccountTarget, self: boolean) =>
      self
        ? translate(locale, 'admin:accountDialogs.resetSelfConfirm')
        : translate(locale, 'admin:accountDialogs.resetAdminConfirm', {
            name: target.name,
          }),
    done: (locale: Locale, target: AccountTarget) =>
      translate(locale, 'admin:accountDialogs.resetDoneAdmin', {
        name: target.name,
      }),
    effect: (locale: Locale, target: AccountTarget) =>
      translate(locale, 'admin:accountDialogs.resetEffectAdmin', {
        email: target.email,
        name: target.name,
      }),
  },
  portal: {
    operation: 'resetPortalAccountPassword',
    recipient: 'admin:accountDialogs.portalRecipient',
    confirm: (locale: Locale) =>
      translate(locale, 'admin:accountDialogs.resetPortalConfirm'),
    done: (locale: Locale) =>
      translate(locale, 'admin:accountDialogs.resetDonePortal'),
    effect: (locale: Locale, target: AccountTarget) =>
      translate(locale, 'admin:accountDialogs.resetEffectPortal', {
        email: target.email,
      }),
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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
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
        title={copy.done(locale, target)}
        description={copy.effect(locale, target)}
      >
        <Heading
          title={copy.done(locale, target)}
          sub={copy.effect(locale, target)}
        />
        <TemporaryPassword
          value={password}
          recipient={translate(locale, copy.recipient)}
          logged={t('admin:accountDialogs.logged')}
        />
        <div className={dialogActions}>
          <Button variant="outline" onClick={onClose}>
            {t('admin:accountDialogs.copiedClose')}
          </Button>
        </div>
      </ModalDialog>
    );

  const title =
    target.audience === 'admin'
      ? t('admin:accountDialogs.resetAdminTitle', { name: target.name })
      : t('admin:accountDialogs.resetPortalTitle');
  return (
    <ModalDialog
      open
      {...(reset.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={title}
      description={copy.confirm(locale, target, self)}
    >
      <Heading title={title} sub={target.email} />
      <p className="m-0 text-sm leading-relaxed">
        {copy.confirm(locale, target, self)}
        {t('admin:accountDialogs.resetOnlyOnce', {
          recipient: translate(locale, copy.recipient),
        })}
      </p>
      {reset.error ? (
        <ProblemAlert
          error={reset.error}
          networkMessage={t('admin:accountDialogs.resetNetwork')}
        />
      ) : null}
      <div className={dialogActions}>
        <Button variant="outline" disabled={reset.isPending} onClick={onClose}>
          {t('admin:accountDialogs.cancel')}
        </Button>
        <Button disabled={reset.isPending} onClick={() => void confirm()}>
          {reset.isPending
            ? t('admin:accountDialogs.resetting')
            : t('admin:accountDialogs.resetPassword')}
        </Button>
      </div>
    </ModalDialog>
  );
}

type StatusCopy = {
  title: (locale: Locale, target: AccountTarget) => string;
  body: (locale: Locale, target: AccountTarget) => string;
  note?: { title: string; body: string; tone: 'error' | 'brand' };
  confirm: string;
};

const statusCopy = {
  admin: {
    disable: {
      title: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.admin.disable.title', {
          name: target.name,
        }),
      body: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.admin.disable.body', {
          name: target.name,
        }),
      confirm: 'admin:accountDialogs.status.admin.disable.confirm',
    },
    enable: {
      title: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.admin.enable.title', {
          name: target.name,
        }),
      body: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.admin.enable.body', {
          name: target.name,
        }),
      confirm: 'admin:accountDialogs.status.admin.enable.confirm',
    },
  },
  portal: {
    disable: {
      title: (locale) =>
        translate(locale, 'admin:accountDialogs.status.portal.disable.title'),
      body: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.portal.disable.body', {
          email: target.email,
        }),
      note: {
        title: 'admin:accountDialogs.portalDisableNoteTitle',
        body: 'admin:accountDialogs.portalDisableNoteBody',
        tone: 'error',
      },
      confirm: 'admin:accountDialogs.status.portal.disable.confirm',
    },
    enable: {
      title: (locale) =>
        translate(locale, 'admin:accountDialogs.status.portal.enable.title'),
      body: (locale, target) =>
        translate(locale, 'admin:accountDialogs.status.portal.enable.body', {
          email: target.email,
        }),
      confirm: 'admin:accountDialogs.status.portal.enable.confirm',
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
  LAST_ADMIN: 'admin:accountDialogs.refusalLastAdmin',
  SELF_DISABLE: 'admin:accountDialogs.refusalSelfDisable',
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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
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
  const title = copy.title(locale, target);
  const body = copy.body(locale, target);

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
        title={t('admin:accountDialogs.cannotDisable')}
        description={translate(locale, refused)}
      >
        <Heading
          title={t('admin:accountDialogs.cannotDisable')}
          sub={translate(locale, refused)}
        />
        <div className={dialogActions}>
          <Button onClick={onClose}>{t('admin:accountDialogs.known')}</Button>
        </div>
      </ModalDialog>
    );

  return (
    <ModalDialog
      open
      {...(mutation.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={title}
      description={body}
    >
      <Heading title={title} sub={body} />
      {copy.note ? (
        <Alert variant={copy.note.tone} role="note" className="text-foreground">
          <span className="font-semibold">
            {translate(locale, copy.note.title)}
          </span>
          <span>{translate(locale, copy.note.body)}</span>
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
          networkMessage={t('admin:accountDialogs.statusNetwork')}
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
          {t('admin:accountDialogs.cancel')}
        </Button>
        <Button
          className={
            action === 'disable' ? 'bg-destructive text-white' : undefined
          }
          disabled={mutation.isPending}
          onClick={() => void confirm()}
        >
          {translate(locale, copy.confirm)}
        </Button>
      </div>
    </ModalDialog>
  );
}

const noticeCopy = {
  admin: {
    disable: {
      changed: 'admin:accountDialogs.notice.adminDisableChanged',
      same: 'admin:accountDialogs.notice.adminDisableSame',
    },
    enable: {
      changed: 'admin:accountDialogs.notice.adminEnableChanged',
      same: 'admin:accountDialogs.notice.adminEnableSame',
    },
  },
  portal: {
    disable: {
      changed: 'admin:accountDialogs.notice.portalDisableChanged',
      same: 'admin:accountDialogs.notice.portalDisableSame',
    },
    enable: {
      changed: 'admin:accountDialogs.notice.portalEnableChanged',
      same: 'admin:accountDialogs.notice.portalEnableSame',
    },
  },
} as const;

export function StatusChangeNotice({ change }: { change: StatusChange }) {
  const locale = useLocale();
  const key =
    noticeCopy[change.target.audience][change.action][
      change.changed ? 'changed' : 'same'
    ];
  const text = translate(locale, key, { name: change.target.name });
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
