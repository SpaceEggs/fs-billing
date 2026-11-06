import { translate } from '@fs-billing/shared';
import { useLocale } from '../i18n';
import { cn } from '../lib/utils';
import { Badge } from './ui/badge';

/** 状态标签的色调对应 Badge 的变体。 */
const tones = {
  ok: 'ok',
  warn: 'warning',
  err: 'error',
  off: 'off',
  unv: 'unverified',
  plain: 'plain',
  muted: 'muted',
} as const;

const zhLabel = (status: string) => translate('zh', `common:status.${status}`);

/**
 * 设计系统 · 状态标签：租户状态带圆点，其余为纯文字标签。后台手机稿的租户状态不带圆点，
 * 门户首页手机稿（1b、1c、1d）带，所以圆点默认只在电脑上显示，门户首页传 `alwaysDot`。
 * `label` 固定为中文，供尚未迁移的后台页面拼接文字；显示一律由 StatusTag 按界面语言取。
 */
export const statusTags = {
  normal: { label: zhLabel('normal'), tone: 'ok', dot: true },
  lowBalance: { label: zhLabel('lowBalance'), tone: 'warn', dot: true },
  overdrawn: { label: zhLabel('overdrawn'), tone: 'warn', dot: true },
  suspended: { label: zhLabel('suspended'), tone: 'err', dot: true },
  disabled: { label: zhLabel('disabled'), tone: 'off', dot: true },
  paid: { label: zhLabel('paid'), tone: 'ok', dot: false },
  unpaid: { label: zhLabel('unpaid'), tone: 'warn', dot: false },
  voided: { label: zhLabel('voided'), tone: 'muted', dot: false },
  answered: { label: zhLabel('answered'), tone: 'plain', dot: false },
  unanswered: { label: zhLabel('unanswered'), tone: 'muted', dot: false },
  unverified: { label: zhLabel('unverified'), tone: 'unv', dot: false },
  settingsMissing: {
    label: zhLabel('settingsMissing'),
    tone: 'unv',
    dot: false,
  },
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
  const locale = useLocale();
  const tag = statusTags[status];
  return (
    <Badge variant={tones[tag.tone]} className={className}>
      {tag.dot ? (
        <span
          aria-hidden
          className={cn(
            'size-1.5 rounded-full bg-current',
            !alwaysDot && 'hidden md:block',
          )}
        />
      ) : null}
      {translate(locale, `common:status.${status}`)}
    </Badge>
  );
}
