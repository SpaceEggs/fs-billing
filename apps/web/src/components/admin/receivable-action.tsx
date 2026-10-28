import { Alert } from '../ui/alert';
import type { ListRefresh } from '../../lib/receivables';
import { Button } from '../ui/button';
import { Field, invalidClass } from './form-fields';
import { ProblemAlert } from './problem-alert';
import { cn } from '../../lib/utils';

export function RefreshLine({
  refresh,
  onRetry,
}: {
  refresh: ListRefresh;
  onRetry: () => void;
}) {
  if (refresh === 'fresh') return <span>列表已刷新。</span>;
  if (refresh === 'refreshing') return <span>正在刷新列表…</span>;
  return (
    <span className="flex items-center justify-between gap-2">
      <span>列表刷新失败，页面显示的可能不是最新状态。</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        重试刷新
      </Button>
    </span>
  );
}

function Warning({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Alert variant="warning" role="alert">
      <span className="font-semibold">{title}</span>
      {children}
    </Alert>
  );
}

/**
 * 收款操作对话框的结果区：409 状态已变（附刷新进度）、刷新后的列表显示该行已变（快照作废，须重新打开）、
 * 其余失败（网络中断时附刷新进度）。三者互斥，按此优先级显示。
 */
export function ActionOutcome({
  stale,
  superseded,
  failure,
  refresh,
  onRetryRefresh,
  pending,
}: {
  stale: { title: string; message: string } | null;
  superseded: { title: string; message: string } | null;
  failure: { error: unknown; unknown: boolean; networkMessage: string } | null;
  refresh: ListRefresh;
  onRetryRefresh: () => void;
  pending: boolean;
}) {
  if (stale)
    return (
      <Warning title={stale.title}>
        <span>{stale.message}</span>
        <RefreshLine refresh={refresh} onRetry={onRetryRefresh} />
      </Warning>
    );
  if (superseded && !pending)
    return (
      <Warning title={superseded.title}>
        <span>{superseded.message}</span>
      </Warning>
    );
  if (failure)
    return (
      <>
        <ProblemAlert
          error={failure.error}
          networkMessage={failure.networkMessage}
        />
        {failure.unknown ? (
          <p className="m-0 text-[13px] text-muted-foreground">
            <RefreshLine refresh={refresh} onRetry={onRetryRefresh} />
          </p>
        ) : null}
      </>
    );
  return null;
}

export function ReasonField({
  label,
  value,
  error,
  disabled,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  error: string | undefined;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} required error={error}>
      {(props) => (
        <textarea
          {...props}
          rows={2}
          maxLength={2000}
          placeholder={placeholder}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            'resize-none rounded-lg border border-input bg-transparent px-3 py-2 text-base font-normal outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 md:text-sm',
            invalidClass(error),
          )}
        />
      )}
    </Field>
  );
}
