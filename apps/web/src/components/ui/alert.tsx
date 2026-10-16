import { cn } from '../../lib/utils';

const tones = {
  neg: 'border-alert-neg-border bg-alert-neg-soft text-alert-neg',
  warn: 'border-warn-border bg-warn-soft text-warn',
  ok: 'border-ok-border bg-ok-soft text-ok',
} as const;

export function Alert({
  tone,
  title,
  children,
  className,
}: {
  tone: keyof typeof tones;
  title: string;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'ok' ? 'status' : 'alert'}
      className={cn(
        'flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-[13px] leading-normal',
        tones[tone],
        className,
      )}
    >
      <span className="font-semibold">{title}</span>
      {children ? <span>{children}</span> : null}
    </div>
  );
}

const iconTones = {
  ok: 'border border-ok-border bg-ok-soft text-ok',
  warn: 'border-[1.5px] border-current text-warn',
  err: 'border-[1.5px] border-current text-err',
} as const;

/** 提示框开头的圆形图标：警告与错误为「!」，成功为「✓」。 */
export function CalloutIcon({ tone }: { tone: keyof typeof iconTones }) {
  return (
    <span
      aria-hidden
      className={cn(
        'mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
        iconTones[tone],
      )}
    >
      {tone === 'ok' ? '✓' : '!'}
    </span>
  );
}
