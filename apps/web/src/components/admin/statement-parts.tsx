import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import {
  reconcileNote,
  regenerateReason,
  type ReconcileStatus,
  type RegenerateReason,
} from '../../lib/admin-statements';
import { formatDate, formatShortDateTime, formatTime } from '../../lib/format';
import { useLocale } from '../../i18n';

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
  reason: RegenerateReason | null;
  /** 读屏用名称，如「重新生成 ABC001 2026年8月」。 */
  label: string;
  mobile?: boolean;
  /** 替换默认尺寸（表格行内 30px、手机卡片 40px）。 */
  className?: string;
  onClick: () => void;
}) {
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={label}
      disabled={!allowed}
      {...(reason ? { title: regenerateReason(reason, locale) } : {})}
      onClick={onClick}
      className={cn(
        'bg-background',
        className ?? (mobile ? 'h-10 flex-1' : 'h-[30px]'),
      )}
    >
      {t('admin:statement.parts.regenerate')}
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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
  const mismatch = reconcileNote(reconcileStatus, locale);
  const regenerated =
    version > 1 &&
    firstGeneratedAt !== null &&
    firstGeneratedAt !== generatedAt;
  const original =
    firstGeneratedAt === null
      ? null
      : locale === 'en'
        ? `${formatDate(firstGeneratedAt, locale)} ${formatTime(firstGeneratedAt)}`
        : formatShortDateTime(firstGeneratedAt, locale, false);
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
      {regenerated && original !== null ? (
        <span className="text-[11px] text-primary">
          {t('admin:statement.parts.regenerated', { time: original })}
        </span>
      ) : null}
      {detailsDeleted ? (
        <span className="text-[11px] text-muted-foreground">
          {t('admin:statement.parts.detailsDeleted')}
        </span>
      ) : null}
    </>
  );
}
