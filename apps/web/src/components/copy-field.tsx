import { useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';

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

/**
 * 只读等宽显示一段需要复制的文字（如 billing_tenant），长值换行完整显示；复制后显示“已复制 ✓”。
 * 手机上（稿 4e）复制是框内右侧的文字按钮，电脑上是框外的描边按钮。
 */
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
      <div className="flex min-h-11 items-center gap-1 rounded-lg border border-border bg-card py-1 pr-1 pl-3 has-[textarea:focus-visible]:ring-[3px] has-[textarea:focus-visible]:ring-ring/50 md:min-h-0 md:gap-2 md:border-0 md:bg-transparent md:p-0 md:has-[textarea:focus-visible]:ring-0">
        <textarea
          readOnly
          rows={1}
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="field-sizing-content min-w-0 flex-1 resize-none bg-transparent py-1.5 font-mono text-sm break-all outline-none md:min-h-10 md:rounded-lg md:border md:border-input md:bg-card md:px-3 md:py-2 md:focus-visible:ring-[3px] md:focus-visible:ring-ring/50"
        />
        <Button
          variant="ghost"
          className="h-9 shrink-0 px-2.5 text-[13px] font-normal text-primary md:h-10 md:border md:border-input md:px-4 md:text-sm md:font-medium md:text-foreground"
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
