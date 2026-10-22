import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  reconcileNote,
  regenerateReasons,
  type ReconcileStatus,
} from '../../lib/statements';
import { formatDateTime } from '../../lib/format';

/** 「重新生成」按钮；不可用时置灰，原因写在 title 里（运营稿 5a：话单已删除的行）。 */
export function RegenerateButton({
  allowed,
  reason,
  label,
  mobile = false,
  className,
  onClick,
}: {
  allowed: boolean;
  reason: keyof typeof regenerateReasons | null;
  /** 读屏用名称，如「重新生成 ABC001 2026年8月」。 */
  label: string;
  mobile?: boolean;
  /** 替换默认尺寸（表格行内 30px、手机卡片 40px）。 */
  className?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      disabled={!allowed}
      {...(reason ? { title: regenerateReasons[reason] } : {})}
      onClick={onClick}
      className={cn(
        'bg-background',
        className ?? (mobile ? 'h-10 flex-1' : 'h-[30px]'),
      )}
    >
      重新生成
    </Button>
  );
}

/** 生成时间下方的备注（决定 27）：账单已过期 / 账单与流水不一致、已重新生成、话单已删除。 */
export function GenerationNotes({
  reconcileStatus,
  version,
  generatedAt,
  firstGeneratedAt,
  detailsDeleted,
}: {
  reconcileStatus: ReconcileStatus | null;
  version: number;
  generatedAt: string | null;
  firstGeneratedAt: string | null;
  detailsDeleted: boolean;
}) {
  const mismatch = reconcileNote(reconcileStatus);
  const regenerated =
    version > 1 &&
    firstGeneratedAt !== null &&
    firstGeneratedAt !== generatedAt;
  return (
    <>
      {mismatch ? (
        <span
          className={cn(
            'text-[11px] font-medium',
            reconcileStatus === 'inconsistent' ? 'text-neg' : 'text-warn',
          )}
        >
          {mismatch}
        </span>
      ) : null}
      {regenerated ? (
        <span className="text-[11px] text-primary">
          已重新生成 · 原 {formatDateTime(firstGeneratedAt).slice(5, 16)}
        </span>
      ) : null}
      {detailsDeleted ? (
        <span className="text-[11px] text-muted-foreground">
          该月话单已删除
        </span>
      ) : null}
    </>
  );
}
