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
  const pages = Math.max(1, Math.ceil(rowCount / pageSize));
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="分页"
      className="flex items-center justify-end gap-3 text-[13px] text-muted-foreground"
    >
      <span>
        第 {page} / {pages} 页
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </Button>
    </nav>
  );
}
