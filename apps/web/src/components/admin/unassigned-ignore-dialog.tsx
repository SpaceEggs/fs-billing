import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { UnassignedSelection } from '@fs-billing/shared';
import { invalidateUnassigned, send } from '../../lib/admin-api';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { Field, invalidClass } from './form-fields';
import { RequestFailure } from './problem-alert';

const quickReasons = [
  { label: '测试呼叫', text: '测试呼叫，不属于任何客户' },
  { label: '内部线路', text: '内部线路' },
  { label: '重复话单', text: '重复话单' },
] as const;

type Submit = 'idle' | 'submitting' | { error: unknown };

type IgnoreFlow = {
  reason: string;
  /** 空原因的提示只在点过提交之后出现。 */
  attempted: boolean;
  submit: Submit;
};

export function UnassignedIgnoreDialog({
  open,
  selection,
  count,
  subtitle,
  onOpenChange,
  onIgnored,
}: {
  open: boolean;
  selection: UnassignedSelection;
  count: number;
  subtitle: string;
  onOpenChange: (open: boolean) => void;
  onIgnored: (changed: number) => void;
}) {
  const [locked, setLocked] = useState(false);
  return (
    <ModalDialog
      open={open}
      {...(locked ? {} : { onOpenChange })}
      title={`忽略 ${count} 条话单`}
      description={subtitle}
      className="md:w-[560px]"
    >
      {open ? (
        <IgnoreForm
          selection={selection}
          count={count}
          subtitle={subtitle}
          onOpenChange={onOpenChange}
          onIgnored={onIgnored}
          onLockedChange={setLocked}
        />
      ) : null}
    </ModalDialog>
  );
}

function IgnoreForm({
  selection,
  count,
  subtitle,
  onOpenChange,
  onIgnored,
  onLockedChange,
}: {
  selection: UnassignedSelection;
  count: number;
  subtitle: string;
  onOpenChange: (open: boolean) => void;
  onIgnored: (changed: number) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<IgnoreFlow>({
    reason: '',
    attempted: false,
    submit: 'idle',
  });
  const submitting = flow.submit === 'submitting';
  const error =
    flow.attempted && flow.reason.trim() === '' ? '请填写忽略原因' : undefined;

  async function submit() {
    if (submitting) return;
    if (flow.reason.trim() === '') {
      setFlow({ ...flow, attempted: true });
      return;
    }
    setFlow({ ...flow, attempted: true, submit: 'submitting' });
    onLockedChange(true);
    try {
      const result = await send('adminUnassignedIgnore', {
        body: { selection, reason: flow.reason.trim() },
      });
      await invalidateUnassigned(queryClient);
      onLockedChange(false);
      onIgnored(result.changed);
    } catch (caught) {
      onLockedChange(false);
      setFlow({ ...flow, attempted: true, submit: { error: caught } });
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1 pr-8">
        <h2 className="m-0 text-[17px] font-semibold">忽略 {count} 条话单</h2>
        <p className="m-0 text-[13px] text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {quickReasons.map((reason) => (
          <button
            key={reason.label}
            type="button"
            disabled={submitting}
            onClick={() =>
              setFlow({ reason: reason.text, attempted: false, submit: 'idle' })
            }
            className="flex h-9 items-center rounded-full border border-input px-3 text-[13px] outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
          >
            {reason.label}
          </button>
        ))}
      </div>
      <Field label="忽略原因" required error={error}>
        {(props) => (
          <textarea
            {...props}
            rows={3}
            maxLength={2000}
            disabled={submitting}
            placeholder="说明忽略这些话单的原因，例如：FreeSWITCH 测试呼叫，不属于任何客户"
            value={flow.reason}
            onChange={(event) =>
              setFlow({
                reason: event.target.value,
                attempted: false,
                submit: 'idle',
              })
            }
            className={cn(
              'resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm',
              invalidClass(error),
            )}
          />
        )}
      </Field>
      <p className="m-0 text-[13px] leading-normal text-muted-foreground">
        忽略的话单不计费，移到「已忽略」标签页，可随时撤销。忽略和撤销均记入操作日志。
      </p>
      {flow.submit !== 'idle' && flow.submit !== 'submitting' ? (
        <RequestFailure error={flow.submit.error} />
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={submitting}
          onClick={() => onOpenChange(false)}
        >
          取消
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={submitting}
          onClick={() => void submit()}
        >
          {submitting ? '正在忽略…' : `忽略 ${count} 条`}
        </Button>
      </div>
    </>
  );
}
