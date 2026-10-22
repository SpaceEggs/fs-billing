import { cn } from '../lib/utils';

const tones = {
  ok: 'border-ok-border bg-ok-soft text-ok',
  warn: 'border-warn-border bg-warn-soft text-warn',
  err: 'border-err-border bg-err-soft text-err',
  off: 'border-off-border bg-off-soft text-off',
  unv: 'border-unv-border bg-unv-soft text-unv',
  plain: 'border-border text-foreground',
  muted: 'border-border text-muted-foreground',
} as const;

/**
 * 设计系统 · 状态标签：租户状态带圆点，其余为纯文字标签。后台手机稿的租户状态不带圆点，
 * 门户首页手机稿（1b、1c、1d）带，所以圆点默认只在电脑上显示，门户首页传 `alwaysDot`。
 */
export const statusTags = {
  normal: { label: '正常', tone: 'ok', dot: true },
  lowBalance: { label: '余额不足', tone: 'warn', dot: true },
  overdrawn: { label: '透支中', tone: 'warn', dot: true },
  suspended: { label: '已停机', tone: 'err', dot: true },
  disabled: { label: '已停用', tone: 'off', dot: true },
  paid: { label: '已收款', tone: 'ok', dot: false },
  unpaid: { label: '待收款', tone: 'warn', dot: false },
  voided: { label: '已作废', tone: 'muted', dot: false },
  answered: { label: '已接通', tone: 'plain', dot: false },
  unanswered: { label: '未接通', tone: 'muted', dot: false },
  unverified: { label: '未经验证', tone: 'unv', dot: false },
  settingsMissing: { label: '未配置提醒设置', tone: 'unv', dot: false },
} as const satisfies Record<
  string,
  { label: string; tone: keyof typeof tones; dot: boolean }
>;

export type StatusKey = keyof typeof statusTags;

export function StatusTag({
  status,
  className,
  alwaysDot = false,
}: {
  status: StatusKey;
  className?: string | undefined;
  /** 手机上也显示圆点（门户首页）。 */
  alwaysDot?: boolean;
}) {
  const tag = statusTags[status];
  return (
    <span
      className={cn(
        'inline-flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-xs font-medium',
        tones[tag.tone],
        className,
      )}
    >
      {tag.dot ? (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full bg-current',
            !alwaysDot && 'hidden md:block',
          )}
        />
      ) : null}
      {tag.label}
    </span>
  );
}
