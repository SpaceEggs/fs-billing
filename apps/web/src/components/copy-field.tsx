import { useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** 只读输入框等宽显示一段需要复制的文字（临时密码、billing_tenant），复制后按钮显示“已复制 ✓”。 */
export function CopyField({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
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
          onClick={() => {
            // 非安全上下文没有 navigator.clipboard，同样按失败处理。
            Promise.resolve()
              .then(() => navigator.clipboard.writeText(value))
              .then(() => setState('copied'))
              .catch(() => setState('failed'));
          }}
        >
          {state === 'copied' ? '已复制 ✓' : '复制'}
        </Button>
      </div>
      {state === 'failed' ? (
        <span role="alert" className="text-xs text-neg">
          无法访问剪贴板，请手动选中复制
        </span>
      ) : null}
    </div>
  );
}
