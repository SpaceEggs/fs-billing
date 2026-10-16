import { useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

function useCopy(value: string) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    // 非安全上下文没有 navigator.clipboard，同样按失败处理。
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(() => setState('copied'))
      .catch(() => setState('failed'));
  };
  return { state, copy };
}

function CopyFailed() {
  return (
    <span role="alert" className="text-xs text-neg">
      无法访问剪贴板，请手动选中复制
    </span>
  );
}

/** 只读输入框等宽显示一段需要复制的文字（如 billing_tenant），复制后按钮显示“已复制 ✓”。 */
export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { state, copy } = useCopy(value);
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="flex-1 bg-card font-mono sm:text-sm md:h-10"
        />
        <Button
          variant="outline"
          className="h-11 md:h-10"
          aria-label={`复制 ${label}`}
          onClick={copy}
        >
          {state === 'copied' ? '已复制 ✓' : '复制'}
        </Button>
      </div>
      {state === 'failed' ? <CopyFailed /> : null}
    </div>
  );
}

/**
 * 只显示一次的临时密码（系统与账号稿 2d / 2h）：大号等宽字醒目显示、可整段换行，
 * 手机上也能完整读出；主色复制按钮在手机上为整行「复制临时密码」。
 */
export function SecretField({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  const { state, copy } = useCopy(value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:gap-2 md:rounded-[10px] md:border md:border-border md:bg-muted md:py-2 md:pr-2 md:pl-4">
        <textarea
          readOnly
          rows={2}
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="field-sizing-content w-full resize-none rounded-[10px] border border-border bg-muted px-4 py-3.5 text-center font-mono text-[22px] leading-snug font-semibold tracking-[.06em] break-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:min-w-0 md:flex-1 md:rounded-md md:border-0 md:bg-transparent md:px-0 md:py-1 md:text-left md:text-lg"
        />
        <Button
          className="h-11 text-base md:h-9 md:text-sm"
          aria-label={`复制 ${label}`}
          onClick={copy}
        >
          {state === 'copied' ? (
            '已复制 ✓'
          ) : (
            <>
              <span className="md:hidden">复制{label}</span>
              <span className="hidden md:inline">复制</span>
            </>
          )}
        </Button>
      </div>
      {state === 'failed' ? <CopyFailed /> : null}
    </div>
  );
}
