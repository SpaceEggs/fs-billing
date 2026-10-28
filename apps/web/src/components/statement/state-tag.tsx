import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import type { StatementState } from '../../lib/statement';

/**
 * 月份旁的状态标签（设计稿 1a、2a）：进行中为带绿点的描边标签，待生成（月份已结束、账单尚未生成）为灰色文字标签。
 * 已生成的账单没有标签。`size` 对应稿中列表（22px）、详情标题（24px）、手机（20px）三种高度。
 */
export function StatementStateTag({
  state,
  size = 'md',
  className,
}: {
  state: StatementState;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  if (state === 'final') return null;
  return (
    <Badge
      variant={state === 'in_progress' ? 'plain' : 'muted'}
      className={cn(
        size === 'sm' && 'h-5 gap-[5px] rounded-[5px] px-1.5 text-[11px]',
        size === 'lg' && 'h-6 px-[9px]',
        className,
      )}
    >
      {state === 'in_progress' ? (
        <span aria-hidden className="size-1.5 rounded-full bg-pos" />
      ) : null}
      {state === 'in_progress' ? '本月（进行中）' : '待生成'}
    </Badge>
  );
}
