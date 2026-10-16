import { useQueryClient } from '@tanstack/react-query';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { ProblemAlert } from './problem-alert';

export type StatusChangeResult = {
  action: 'disable' | 'enable';
  /** 服务端返回 auditId 为 null：租户已是目标状态，没有变更。 */
  changed: boolean;
};

const copy = {
  disable: {
    title: (code: string) => `停用租户 ${code}？`,
    confirm: '停用租户',
    tone: 'border-err-border bg-err-soft',
    noteTitle: '停用不能保证立即停止呼叫',
    note: '停用后正常授权路径拒绝新呼叫；Worker 授权超时时，新呼叫仍可能按最多 1800 秒放行；已接通电话按原上限结束并正常计费。',
    effects: [
      '客户门户账号无法登录，门户账号本身的状态不变。',
      '余额、费率和流水保留；仍可充值、赊账充值、赠送和调账，入账不会自动启用租户。',
      '可随时重新启用，停用和启用均记入操作日志。',
    ],
  },
  enable: {
    title: (code: string) => `启用租户 ${code}？`,
    confirm: '启用租户',
    tone: 'border-brand-border bg-brand-soft',
    noteTitle: '恢复正常授权',
    note: '启用后按余额与透支额度正常授权新呼叫；余额不足时仍会停机。',
    effects: [
      '只恢复租户状态，不改变门户账号：门户账号若已单独停用，需在「门户账号」标签页启用。',
      '启用记入操作日志。',
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
  const mutation = action === 'enable' ? enable : disable;
  const text = copy[action ?? 'disable'];

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
      title={text.title(tenant.code)}
      description={text.note}
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-[17px] font-semibold">
          {text.title(tenant.code)}
        </h2>
        <span className="text-sm leading-relaxed text-muted-foreground">
          {tenant.name}（{tenant.currency}）
        </span>
      </div>
      <div
        className={`flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-[13px] leading-normal ${text.tone}`}
      >
        <span className="font-semibold">{text.noteTitle}</span>
        <span>{text.note}</span>
      </div>
      <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-[13px] leading-normal text-muted-foreground">
        {text.effects.map((effect) => (
          <li key={effect}>{effect}</li>
        ))}
      </ul>
      {mutation.error ? (
        <ProblemAlert
          error={mutation.error}
          networkMessage="无法确认是否已生效，请刷新页面查看租户状态后再操作。"
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
          取消
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
          {text.confirm}
        </Button>
      </div>
    </ModalDialog>
  );
}
