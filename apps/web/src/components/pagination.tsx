import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';

/** 前端分页：取第 `page` 页（从 1 开始）的条目。 */
export function pageSlice<Item>(items: Item[], page: number, pageSize: number) {
  const start = (page - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function Pagination({
  page,
  pageSize,
  rowCount,
  onPage,
}: {
  page: number;
  pageSize: number;
  rowCount: number;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(['common']);
  const pages = Math.max(1, Math.ceil(rowCount / pageSize));
  if (pages <= 1) return null;
  return (
    <nav
      aria-label={t('pagination.label')}
      className="flex items-center justify-end gap-3 text-[13px] text-muted-foreground"
    >
      <span>{t('pagination.page', { page, pages })}</span>
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        {t('pagination.previous')}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        {t('pagination.next')}
      </Button>
    </nav>
  );
}
