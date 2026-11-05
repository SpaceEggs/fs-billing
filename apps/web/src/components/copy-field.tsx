import { useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

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
      <div className="flex items-start gap-2">
        <Textarea
          readOnly
          rows={1}
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-9 min-w-0 flex-1 resize-none font-mono break-all"
        />
        <Button
          variant="outline"
          className="shrink-0"
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
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:gap-2">
        <Textarea
          readOnly
          rows={2}
          value={value}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-9 resize-none bg-muted text-center font-mono text-lg font-semibold break-all md:min-w-0 md:flex-1 md:text-left md:text-lg"
        />
        <Button
          className="max-md:h-11"
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
