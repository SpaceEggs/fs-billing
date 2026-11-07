import { OptionTabs } from '../option-tabs';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import {
  translate,
  type AdminBalanceOperationResponse,
  type AdminTenantDetailResponse,
} from '@fs-billing/shared';
import { CheckIcon } from 'lucide-react';
import { Checkbox } from '../ui/checkbox';
import { Textarea } from '../ui/textarea';
import { Alert } from '../ui/alert';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { ApiRequestError } from '../../lib/api';
import { apiProblem } from '../../lib/api-problem';
import {
  beginBalanceAttempt,
  balanceFieldErrors,
  balanceKindConfirmType,
  balanceKindHint,
  balanceKindLabel,
  balanceKindOrder,
  balanceKinds,
  balanceRequest,
  needsLargeAmountConfirm,
  projectBalance,
  validateBalanceDraft,
  type BalanceDraft,
  type BalanceErrors,
  type BalanceKind,
} from '../../lib/balance-operation';
import {
  resolveBalanceAttempt,
  type BalanceAttempt,
} from '../../lib/balance-attempts';
import { normalizeAmountInput } from '../../lib/amounts';
import { formatExactMoney, formatMoney } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useLocale } from '../../i18n';
import { webConfig } from '../../config';
import { Money } from '../data-format';
import { statusTags } from '../status-tag';
import { healthStatus } from '../tenant-health';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { Field, invalidClass, MoneyInput } from './form-fields';
import { ProblemAlert } from './problem-alert';

type Step =
  | { name: 'form' }
  | { name: 'confirm' }
  | { name: 'done'; result: AdminBalanceOperationResponse };

/** 本次操作金额按输入精度带正负号显示：“+¥500.00”“-¥12.3456”。 */
function signedMoney(
  currency: AdminTenantDetailResponse['currency'],
  amount: string,
) {
  const text = formatExactMoney({ currency, amount });
  return new Decimal(amount).gt(0) ? `+${text}` : text;
}

function VisibilityBadge({ kind }: { kind: BalanceKind }) {
  const { t } = useTranslation(['admin']);
  return balanceKinds[kind].noteVisibility === 'admin' ? (
    <span className="rounded border border-border bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground">
      {t('admin:balanceDialog.visibilityAdmin')}
    </span>
  ) : (
    <span className="rounded bg-brand-soft px-1.5 py-px text-xs font-medium text-primary">
      {t('admin:balanceDialog.visibilityCustomer')}
    </span>
  );
}

function KindChoice({
  value,
  onChange,
  locale,
}: {
  value: BalanceKind;
  onChange: (kind: BalanceKind) => void;
  locale: ReturnType<typeof useLocale>;
}) {
  const { t } = useTranslation(['admin']);
  return (
    <div className="flex flex-col gap-1.5 text-sm font-medium">
      <span aria-hidden>{t('admin:balanceDialog.kindLabel')}</span>
      <OptionTabs
        label={t('admin:balanceDialog.kindLabel')}
        options={balanceKindOrder.map((kind) => ({
          value: kind,
          label: balanceKindLabel(kind, locale),
        }))}
        value={value}
        onChange={onChange}
        className="w-full"
      />
      {value === 'credit_topup' ? (
        <span className="text-xs leading-normal font-normal text-muted-foreground">
          {t('admin:balanceDialog.creditTopupNote')}
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
  const { t } = useTranslation(['admin']);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-3.5 py-3 text-sm tabular-nums">
      <span className="text-muted-foreground">
        {t('admin:balanceDialog.currentBalance')}{' '}
        <Money
          value={{ currency: tenant.currency, amount: tenant.balance }}
          className="font-semibold"
        />
      </span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="text-muted-foreground">
        {t('admin:balanceDialog.afterBalance')}{' '}
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
 * 同一笔内容重试复用幂等键（关闭对话框后重开也一样），网络中断后重试不会重复入账；
 * 提交中不能关闭。赠送、赊账充值超过前端配置阈值时，确认页另需勾选大额确认。
 */
export function BalanceDialog({
  owner,
  tenant,
  open,
  onOpenChange,
  onViewLedger,
  initialDraft,
  thresholds = webConfig.largeAmountThresholds,
}: {
  /** 当前管理员的 profileId；未决幂等键只在同一管理员内复用。 */
  owner: string;
  tenant: AdminTenantDetailResponse;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onViewLedger: () => void;
  /** 打开时预填的内容，例如作废应收所需的冲正调账。 */
  initialDraft?: BalanceDraft;
  thresholds?: typeof webConfig.largeAmountThresholds;
}) {
  const { t } = useTranslation(['admin']);
  const operate = useApiMutation('adminBalanceOperation', {
    invalidate: (queryClient, input) =>
      invalidateTenant(queryClient, input.params.tenantId),
  });
  // 从计算指纹开始到请求结束都算提交中，期间不能关闭或返回修改。
  const [submitting, setSubmitting] = useState(false);
  return (
    <ModalDialog
      open={open}
      {...(submitting ? {} : { onOpenChange })}
      title={t('admin:balanceDialog.title')}
      className="md:w-[460px]"
    >
      {open ? (
        <BalanceFlow
          owner={owner}
          tenant={tenant}
          initialDraft={initialDraft}
          thresholds={thresholds}
          operate={operate}
          submitting={submitting}
          onSubmittingChange={setSubmitting}
          onClose={() => onOpenChange(false)}
          onViewLedger={onViewLedger}
        />
      ) : null}
    </ModalDialog>
  );
}

/** 操作后状态提示框的颜色，与状态标签同色系（稿 3d 为「正常」的绿色）。 */
const outcomeTones = {
  ok: 'border-ok-border bg-ok-soft text-ok',
  warn: 'border-warn-border bg-warn-soft text-warn',
  err: 'border-err-border bg-err-soft text-err',
  off: 'border-off-border bg-off-soft text-off',
} as const;

function BalanceFlow({
  owner,
  tenant,
  initialDraft = { kind: 'topup', amount: '', note: '' },
  thresholds,
  operate,
  submitting,
  onSubmittingChange,
  onClose,
  onViewLedger,
}: {
  owner: string;
  tenant: AdminTenantDetailResponse;
  initialDraft: BalanceDraft | undefined;
  thresholds: typeof webConfig.largeAmountThresholds;
  operate: ReturnType<typeof useApiMutation<'adminBalanceOperation'>>;
  submitting: boolean;
  onSubmittingChange: (submitting: boolean) => void;
  onClose: () => void;
  onViewLedger: () => void;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [errors, setErrors] = useState<BalanceErrors>({});
  const [step, setStep] = useState<Step>({ name: 'form' });
  const [largeConfirmed, setLargeConfirmed] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const rule = balanceKinds[draft.kind];
  const kindLabel = balanceKindLabel(draft.kind, locale);
  const valid = Object.keys(validateBalanceDraft(draft, locale)).length === 0;
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
    const found = validateBalanceDraft(draft, locale);
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
    if (submitting) return;
    onSubmittingChange(true);
    setSubmitError(null);
    let attempt: BalanceAttempt | null = null;
    try {
      attempt = await beginBalanceAttempt(owner, tenant.id, draft);
      // 计算指纹期间对话框已关闭或已退出登录：这一笔作废，不提交。
      if (!attempt || !mounted.current) return;
      const result = await operate.mutateAsync({
        params: { tenantId: tenant.id },
        body: balanceRequest(draft, tenant.currency, attempt.key),
      });
      resolveBalanceAttempt(attempt);
      setStep({ name: 'done', result });
    } catch (error) {
      const problem = apiProblem(error);
      // 服务端明确拒绝即未入账；网络中断、500/503 结果未知，保留幂等键供重试，并刷新余额与流水核对。
      if (problem.kind === 'unavailable')
        void invalidateTenant(queryClient, tenant.id);
      else if (attempt) resolveBalanceAttempt(attempt);
      if (problem.kind === 'validation') {
        setErrors(balanceFieldErrors(problem.issues, locale));
        setStep({ name: 'form' });
        return;
      }
      setSubmitError(error);
    } finally {
      onSubmittingChange(false);
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
            <CheckIcon className="size-6" />
          </span>
          <h2 className="m-0 text-[17px] font-semibold">
            {t('admin:balanceDialog.successTitle')}
          </h2>
          <p
            role="status"
            className="m-0 text-sm leading-relaxed text-muted-foreground tabular-nums"
          >
            {t('admin:balanceDialog.successBody', {
              kind: kindLabel,
              amount: signedMoney(result.currency, result.entry.amount),
              balance: formatMoney({
                currency: result.currency,
                amount: result.balance,
              }),
            })}
            <br />
            {t('admin:balanceDialog.logged')}
          </p>
        </div>
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-center">
          <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
            {t('admin:balanceDialog.done')}
          </Button>
          <Button className="h-12 md:h-9" onClick={onViewLedger}>
            {t('admin:balanceDialog.viewLedger')}
          </Button>
        </div>
      </>
    );
  }

  if (step.name === 'confirm' && projected) {
    const amount = normalizeAmountInput(draft.amount);
    const confirmLabel = t('admin:balanceDialog.confirmTitle', {
      kind: kindLabel,
    });
    return (
      <>
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[17px] font-semibold">{confirmLabel}</h2>
          <span className="text-[13px] leading-normal text-muted-foreground">
            {t('admin:balanceDialog.ledgerNote')}
          </span>
        </div>
        <dl className="m-0 grid grid-cols-[88px_1fr] overflow-hidden rounded-[10px] border border-border text-sm tabular-nums">
          {[
            [t('admin:balanceDialog.tenant'), `${tenant.code} ${tenant.name}`],
            [
              t('admin:balanceDialog.type'),
              balanceKindConfirmType(draft.kind, locale),
            ],
            [
              t('admin:balanceDialog.amount'),
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
              t('admin:balanceDialog.note'),
              <span key="note">
                {draft.note.trim() || t('admin:balanceDialog.emptyNote')}{' '}
                <span className="text-xs text-muted-foreground">
                  {rule.noteVisibility === 'admin'
                    ? t('admin:balanceDialog.internalVisibility')
                    : t('admin:balanceDialog.customerVisibility')}
                </span>
              </span>,
            ],
            [
              t('admin:balanceDialog.balance'),
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
                  'm-0 px-3.5 py-2.5 break-words',
                  index < rows.length - 1 && 'border-b border-border',
                )}
              >
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <div
          className={cn(
            'rounded-lg border px-3.5 py-2.5 text-[13px] tabular-nums',
            outcomeTones[statusTags[healthStatus[projected.health]].tone],
          )}
        >
          {t('admin:balanceDialog.available', {
            kind: kindLabel,
            amount: formatMoney({
              currency: tenant.currency,
              amount: projected.available,
            }),
            change:
              projected.health === tenant.health
                ? t('admin:balanceDialog.stay')
                : t('admin:balanceDialog.become'),
            status: translate(
              locale,
              `common:status.${healthStatus[projected.health]}`,
            ),
          })}
        </div>
        {tenant.status === 'disabled' ? (
          <Alert variant="muted" role="note">
            <span className="font-semibold">
              {t('admin:balanceDialog.disabledTitle')}
            </span>
            <span>{t('admin:balanceDialog.disabledBody')}</span>
          </Alert>
        ) : null}
        {large ? (
          <Alert variant="warning" className="gap-2">
            <span className="font-semibold">
              {t('admin:balanceDialog.largeTitle', { kind: kindLabel })}
            </span>
            <span className="text-foreground">
              {t('admin:balanceDialog.largeBody', {
                currency: tenant.currency,
                amount: formatMoney({
                  currency: tenant.currency,
                  amount: thresholds[tenant.currency],
                }),
              })}
            </span>
            <label className="flex items-center gap-2 font-medium text-foreground">
              <Checkbox
                checked={largeConfirmed}
                onCheckedChange={(next) => setLargeConfirmed(next === true)}
              />
              {t('admin:balanceDialog.largeConfirm', {
                kind: kindLabel,
                amount: signedMoney(tenant.currency, amount),
              })}
            </label>
          </Alert>
        ) : null}
        {submitError ? (
          <ProblemAlert
            error={submitError}
            networkMessage={t('admin:balanceDialog.network', {
              confirm: confirmLabel,
            })}
            onRefresh={() => {
              void invalidateTenant(queryClient, tenant.id);
              // 结果未知时留在确认步骤：核对后可按同一笔重试。
              if (!(
                submitError instanceof ApiRequestError &&
                submitError.outcomeUnknown
              ))
                onClose();
            }}
          />
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={submitting}
            onClick={() => setStep({ name: 'form' })}
          >
            {t('admin:balanceDialog.back')}
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={submitting || (large && !largeConfirmed)}
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
      aria-label={t('admin:balanceDialog.title')}
      onSubmit={(event) => {
        event.preventDefault();
        next();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[17px] font-semibold">
          {t('admin:balanceDialog.title')}
        </h2>
        <span className="hidden text-[13px] text-muted-foreground md:inline">
          {tenantLabel}
        </span>
        <span className="text-xs text-muted-foreground md:hidden">
          {tenant.code} · {tenant.currency}
        </span>
      </div>
      <KindChoice
        value={draft.kind}
        onChange={(kind) => update({ kind })}
        locale={locale}
      />
      <Field
        label={t('admin:balanceDialog.amountLabel')}
        error={errors.amount}
        hint={balanceKindHint(draft.kind, locale)}
      >
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
        label={t('admin:balanceDialog.noteLabel')}
        required={draft.kind === 'adjustment'}
        optional={draft.kind !== 'adjustment'}
        badge={<VisibilityBadge kind={draft.kind} />}
        error={errors.note}
        hint={
          rule.noteVisibility === 'customer'
            ? t('admin:balanceDialog.customerHint')
            : t('admin:balanceDialog.adminHint')
        }
      >
        {(props) => (
          <Textarea
            {...props}
            rows={2}
            maxLength={2000}
            placeholder={
              draft.kind === 'adjustment'
                ? t('admin:balanceDialog.adjustmentPlaceholder')
                : t('admin:balanceDialog.notePlaceholder')
            }
            value={draft.note}
            onChange={(event) => update({ note: event.target.value })}
            className={cn('resize-none font-normal', invalidClass(errors.note))}
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
          {t('admin:balanceDialog.cancel')}
        </Button>
        <Button type="submit" className="h-12 md:h-9">
          {t('admin:balanceDialog.next')}
        </Button>
      </div>
    </form>
  );
}
