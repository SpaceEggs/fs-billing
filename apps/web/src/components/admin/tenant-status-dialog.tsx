import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert } from './problem-alert';

export type StatusChangeResult = {
  action: 'disable' | 'enable';
  /** 服务端返回 auditId 为 null：租户已是目标状态，没有变更。 */
  changed: boolean;
};

const copyKeys = {
  disable: {
    title: 'admin:tenantStatus.disableTitle',
    confirm: 'admin:tenantStatus.disableConfirm',
    tone: 'error',
    noteTitle: 'admin:tenantStatus.disableNoteTitle',
    note: 'admin:tenantStatus.disableNote',
    effects: [
      'admin:tenantStatus.disableEffect1',
      'admin:tenantStatus.disableEffect2',
      'admin:tenantStatus.disableEffect3',
    ],
  },
  enable: {
    title: 'admin:tenantStatus.enableTitle',
    confirm: 'admin:tenantStatus.enableConfirm',
    tone: 'brand',
    noteTitle: 'admin:tenantStatus.enableNoteTitle',
    note: 'admin:tenantStatus.enableNote',
    effects: [
      'admin:tenantStatus.enableEffect1',
      'admin:tenantStatus.enableEffect2',
    ],
  },
} as const;

/** 停用、启用租户的确认（决定 9：停用提示不承诺呼叫停止）。 */
export function TenantStatusDialog({
  tenant,
  action,
  onClose,
  onDone,
}: {
  tenant: AdminTenantDetailResponse;
  action: 'disable' | 'enable' | null;
  onClose: () => void;
  onDone: (result: StatusChangeResult) => void;
}) {
  const queryClient = useQueryClient();
  const disable = useApiMutation('adminTenantDisable', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const enable = useApiMutation('adminTenantEnable', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const { t } = useTranslation(['admin']);
  const mutation = action === 'enable' ? enable : disable;
  const text = copyKeys[action ?? 'disable'];
  const title = t(text.title, { code: tenant.code });

  async function confirm() {
    if (!action) return;
    try {
      const result = await mutation.mutateAsync({
        params: { tenantId: tenant.id },
      });
      onDone({ action, changed: result.auditId !== null });
    } catch {
      // 失败说明由 mutation.error 显示。
    }
  }

  return (
    <ModalDialog
      open={action !== null}
      {...(mutation.isPending
        ? {}
        : {
            onOpenChange: (open: boolean) => {
              if (!open) {
                disable.reset();
                enable.reset();
                onClose();
              }
            },
          })}
      title={title}
      description={t(text.note)}
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[17px] font-semibold">{title}</h2>
        <span className="text-sm leading-relaxed text-muted-foreground">
          {tenant.name}（{tenant.currency}）
        </span>
      </div>
      <Alert variant={text.tone} role="note" className="text-foreground">
        <span className="font-semibold">{t(text.noteTitle)}</span>
        <span>{t(text.note)}</span>
      </Alert>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-normal text-muted-foreground">
        {text.effects.map((effect) => (
          <li key={effect}>{t(effect)}</li>
        ))}
      </ul>
      {mutation.error ? (
        <ProblemAlert
          error={mutation.error}
          networkMessage={t('admin:tenantStatus.network')}
          onRefresh={() => {
            void invalidateTenant(queryClient, tenant.id);
            onClose();
          }}
        />
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          {t('admin:tenantStatus.cancel')}
        </Button>
        <Button
          className={
            action === 'disable'
              ? 'h-12 bg-destructive text-white md:h-9'
              : 'h-12 md:h-9'
          }
          disabled={mutation.isPending}
          onClick={() => void confirm()}
        >
          {t(text.confirm)}
        </Button>
      </div>
    </ModalDialog>
  );
}
