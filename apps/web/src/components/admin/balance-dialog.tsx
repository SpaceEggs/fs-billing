import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import type {
  AdminBalanceOperationResponse,
  AdminTenantDetailResponse,
} from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import {
  balanceFieldErrors,
  balanceKindOrder,
  balanceKinds,
  balanceRequest,
  draftFingerprint,
  needsLargeAmountConfirm,
  newIdempotencyKey,
  projectBalance,
  validateBalanceDraft,
  type BalanceDraft,
  type BalanceErrors,
  type BalanceKind,
} from '../../lib/balance-operation';
import { normalizeAmountInput } from '../../lib/amounts';
import { formatMoney } from '../../lib/format';
import { cn } from '../../lib/utils';
import { webConfig } from '../../config';
import { Money } from '../data-format';
import { StatusTag } from '../status-tag';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { Field, invalidClass, MoneyInput } from './form-fields';
import { ProblemAlert } from './problem-alert';
import { healthStatus } from './tenant-status';

type Step =
  | { name: 'form' }
  | { name: 'confirm' }
  | { name: 'done'; result: AdminBalanceOperationResponse };

/** 带正负号的金额：入账为“+¥500.00”。 */
function signedMoney(
  currency: AdminTenantDetailResponse['currency'],
  amount: string,
) {
  const text = formatMoney({ currency, amount });
  return new Decimal(amount).gt(0) ? `+${text}` : text;
}

function VisibilityBadge({ kind }: { kind: BalanceKind }) {
  return balanceKinds[kind].noteVisibility === 'admin' ? (
    <span className="rounded border border-border bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
      仅内部可见
    </span>
  ) : (
    <span className="rounded bg-brand-soft px-1.5 py-px text-xs font-medium text-primary">
      客户可见
    </span>
  );
}

function KindChoice({
  value,
  onChange,
}: {
  value: BalanceKind;
  onChange: (kind: BalanceKind) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span id="balance-kind-label">操作类型</span>
      <div
        role="radiogroup"
        aria-labelledby="balance-kind-label"
        className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-0.5 md:rounded-lg md:bg-muted md:p-[3px]"
      >
        {balanceKindOrder.map((kind) => (
          <button
            key={kind}
            type="button"
            role="radio"
            aria-checked={value === kind}
            onClick={() => onChange(kind)}
            className={cn(
              'h-11 rounded-lg border text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:h-8 md:rounded-md md:border-0 md:text-[13px]',
              value === kind
                ? 'border-primary bg-brand-soft font-semibold text-primary md:bg-background md:shadow-[0_1px_2px_rgba(0,0,0,.12)]'
                : 'border-input font-normal text-muted-foreground',
            )}
          >
            {balanceKinds[kind].label}
          </button>
        ))}
      </div>
      {value === 'credit_topup' ? (
        <span className="text-xs leading-normal font-normal text-muted-foreground">
          先加余额，记为「待收款」，确认收款后变为「已收款」。客户看到的是「账户充值」。
        </span>
      ) : null}
    </div>
  );
}

function BalancePreview({
  tenant,
  after,
}: {
  tenant: AdminTenantDetailResponse;
  after: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3.5 py-3 text-sm tabular-nums">
      <span className="text-muted-foreground">
        当前余额{' '}
        <Money
          value={{ currency: tenant.currency, amount: tenant.balance }}
          className="font-semibold"
        />
      </span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="text-muted-foreground">
        操作后{' '}
        <span className="font-semibold text-foreground">
          {after === null ? (
            '—'
          ) : (
            <Money value={{ currency: tenant.currency, amount: after }} />
          )}
        </span>
      </span>
    </div>
  );
}

/**
 * 余额操作（设计稿第一批 3a–3e、原型）：填写 → 确认 → 完成。
 * 同一笔内容重试复用幂等键，网络中断后重试不会重复入账。
 * 赠送、赊账充值超过前端配置阈值时，确认页另需勾选大额确认。
 */
export function BalanceDialog({
  tenant,
  open,
  onOpenChange,
  onViewLedger,
  thresholds = webConfig.largeAmountThresholds,
}: {
  tenant: AdminTenantDetailResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewLedger: () => void;
  thresholds?: typeof webConfig.largeAmountThresholds;
}) {
  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title="余额操作"
      className="md:w-[460px]"
    >
      {open ? (
        <BalanceFlow
          tenant={tenant}
          thresholds={thresholds}
          onClose={() => onOpenChange(false)}
          onViewLedger={onViewLedger}
        />
      ) : null}
    </ModalDialog>
  );
}

function BalanceFlow({
  tenant,
  thresholds,
  onClose,
  onViewLedger,
}: {
  tenant: AdminTenantDetailResponse;
  thresholds: typeof webConfig.largeAmountThresholds;
  onClose: () => void;
  onViewLedger: () => void;
}) {
  const [draft, setDraft] = useState<BalanceDraft>({
    kind: 'topup',
    amount: '',
    note: '',
  });
  const [errors, setErrors] = useState<BalanceErrors>({});
  const [step, setStep] = useState<Step>({ name: 'form' });
  const [attempt, setAttempt] = useState<{
    fingerprint: string;
    key: string;
  } | null>(null);
  const [largeConfirmed, setLargeConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const queryClient = useQueryClient();
  const operate = useApiMutation('adminBalanceOperation', {
    invalidate: (queryClient, input) =>
      invalidateTenant(queryClient, input.params.tenantId),
  });

  const rule = balanceKinds[draft.kind];
  const valid = Object.keys(validateBalanceDraft(draft)).length === 0;
  const projected = valid ? projectBalance(tenant, draft.amount) : null;
  const large =
    valid &&
    needsLargeAmountConfirm(
      draft.kind,
      draft.amount,
      tenant.currency,
      thresholds,
    );
  const tenantLabel = `${tenant.code} ${tenant.name}（${tenant.currency}）`;
  const update = (patch: Partial<BalanceDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
  };

  function next() {
    const found = validateBalanceDraft(draft);
    if (Object.keys(found).length) {
      setErrors(found);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]')
          ?.focus(),
      );
      return;
    }
    setLargeConfirmed(false);
    setSubmitError(null);
    setStep({ name: 'confirm' });
  }

  async function submit() {
    const fingerprint = draftFingerprint(draft);
    const key =
      attempt?.fingerprint === fingerprint ? attempt.key : newIdempotencyKey();
    setAttempt({ fingerprint, key });
    setSubmitError(null);
    try {
      const result = await operate.mutateAsync({
        params: { tenantId: tenant.id },
        body: balanceRequest(draft, tenant.currency, key),
      });
      setAttempt(null);
      setStep({ name: 'done', result });
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'validation') {
        setErrors(balanceFieldErrors(problem.issues));
        setStep({ name: 'form' });
        return;
      }
      setSubmitError(error);
    }
  }

  if (step.name === 'done') {
    const { result } = step;
    return (
      <>
        <div className="flex flex-col items-center gap-3 pt-4 text-center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-[22px] font-bold text-ok"
          >
            ✓
          </span>
          <h2 className="m-0 text-[17px] font-semibold">操作成功</h2>
          <p
            role="status"
            className="m-0 text-sm leading-relaxed text-muted-foreground tabular-nums"
          >
            {rule.label} {signedMoney(result.currency, result.entry.amount)}{' '}
            已入账，当前余额{' '}
            {formatMoney({ currency: result.currency, amount: result.balance })}
            <br />
            已记入操作日志
          </p>
        </div>
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-center">
          <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
            完成
          </Button>
          <Button className="h-12 md:h-9" onClick={onViewLedger}>
            查看余额流水
          </Button>
        </div>
      </>
    );
  }

  if (step.name === 'confirm' && projected) {
    const amount = normalizeAmountInput(draft.amount);
    const confirmLabel = `确认${rule.label}`;
    return (
      <>
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">{confirmLabel}</h2>
          <span className="text-[13px] leading-normal text-muted-foreground">
            提交后将新增一条流水，不能修改或删除；如有错误需另做调账冲正。
          </span>
        </div>
        <dl className="m-0 grid grid-cols-[88px_1fr] overflow-hidden rounded-[10px] border border-border text-sm tabular-nums">
          {[
            ['租户', tenantLabel],
            ['类型', rule.confirmType],
            [
              '金额',
              <span
                key="amount"
                className={cn(
                  'text-lg font-semibold',
                  new Decimal(amount).gt(0) ? 'text-pos' : 'text-neg',
                )}
              >
                {signedMoney(tenant.currency, amount)}
              </span>,
            ],
            [
              '备注',
              <span key="note">
                {draft.note.trim() || '（无）'}{' '}
                <span className="text-xs text-muted-foreground">
                  {rule.noteVisibility === 'admin'
                    ? '（仅内部可见）'
                    : '（客户可见）'}
                </span>
              </span>,
            ],
            [
              '余额',
              <span key="balance">
                <Money
                  value={{ currency: tenant.currency, amount: tenant.balance }}
                />{' '}
                →{' '}
                <Money
                  value={{
                    currency: tenant.currency,
                    amount: projected.balance,
                  }}
                  className="font-semibold"
                />
              </span>,
            ],
          ].map(([label, value], index, rows) => (
            <div key={index} className="contents">
              <dt
                className={cn(
                  'bg-muted px-3.5 py-2.5 text-muted-foreground',
                  index < rows.length - 1 && 'border-b border-border',
                )}
              >
                {label}
              </dt>
              <dd
                className={cn(
                  'm-0 px-3.5 py-2.5 break-all',
                  index < rows.length - 1 && 'border-b border-border',
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground tabular-nums">
          操作后状态
          <StatusTag status={healthStatus[projected.health]} />· 可用额度{' '}
          {formatMoney({
            currency: tenant.currency,
            amount: projected.available,
          })}
        </div>
        {tenant.status === 'disabled' ? (
          <div
            role="note"
            className="flex flex-col gap-0.5 rounded-lg border border-off-border bg-off-soft px-3 py-2.5 text-[13px] leading-normal"
          >
            <span className="font-semibold">该租户已停用，状态不会改变</span>
            <span>
              入账后租户仍为「已停用」，不会自动启用，正常授权路径仍拒绝新呼叫。如需恢复呼叫，请在租户详情右上角「启用」。
            </span>
          </div>
        ) : null}
        {large ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warn-border bg-warn-soft px-3 py-2.5 text-[13px] leading-normal text-warn">
            <span className="font-semibold">
              大额{rule.label}，需要二次确认
            </span>
            <span className="text-foreground">
              金额超过 {tenant.currency} 大额阈值{' '}
              {formatMoney({
                currency: tenant.currency,
                amount: thresholds[tenant.currency],
              })}
              ，请再次核对金额与租户。
            </span>
            <label className="flex items-center gap-2 font-medium text-foreground">
              <input
                type="checkbox"
                checked={largeConfirmed}
                onChange={(event) => setLargeConfirmed(event.target.checked)}
                className="size-4 accent-primary"
              />
              我已核对，确认{rule.label} {signedMoney(tenant.currency, amount)}
            </label>
          </div>
        ) : null}
        {submitError ? (
          <ProblemAlert
            error={submitError}
            networkMessage={`无法确认是否已入账。再次点击「${confirmLabel}」会按同一笔重试，不会重复入账；如需修改内容，请先在余额流水中核实。`}
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
            disabled={operate.isPending}
            onClick={() => setStep({ name: 'form' })}
          >
            返回修改
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={operate.isPending || (large && !largeConfirmed)}
            onClick={() => void submit()}
          >
            {confirmLabel}
          </Button>
        </div>
      </>
    );
  }

  return (
    <form
      noValidate
      aria-label="余额操作"
      onSubmit={(event) => {
        event.preventDefault();
        next();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">余额操作</h2>
        <span className="text-[13px] text-muted-foreground">{tenantLabel}</span>
      </div>
      <KindChoice value={draft.kind} onChange={(kind) => update({ kind })} />
      <Field label="金额" error={errors.amount} hint={rule.hint}>
        {(props) => (
          <MoneyInput
            {...props}
            currency={tenant.currency}
            error={errors.amount}
            placeholder="0.00"
            value={draft.amount}
            onChange={(amount) => update({ amount })}
            className={cn(
              'text-base md:text-base',
              projected && new Decimal(normalizeAmountInput(draft.amount)).lt(0)
                ? 'text-neg'
                : undefined,
            )}
          />
        )}
      </Field>
      <Field
        label="备注"
        required={draft.kind === 'adjustment'}
        optional={draft.kind !== 'adjustment'}
        badge={<VisibilityBadge kind={draft.kind} />}
        error={errors.note}
        hint={
          rule.noteVisibility === 'customer'
            ? '会显示在客户门户的余额流水中'
            : '仅管理后台可见'
        }
      >
        {(props) => (
          <textarea
            {...props}
            rows={2}
            maxLength={2000}
            placeholder={
              draft.kind === 'adjustment'
                ? '请说明调账原因'
                : '例如：银行转账 · 招行尾号 6621'
            }
            value={draft.note}
            onChange={(event) => update({ note: event.target.value })}
            className={cn(
              'resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm',
              invalidClass(errors.note),
            )}
          />
        )}
      </Field>
      <BalancePreview tenant={tenant} after={projected?.balance ?? null} />
      {errors.form ? (
        <p role="alert" className="m-0 text-[13px] text-err">
          {errors.form}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" className="h-12 md:h-9">
          下一步
        </Button>
      </div>
    </form>
  );
}
