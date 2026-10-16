import { downloadText } from '../../lib/download';
import { rateCsvTemplate } from '../../lib/rate-csv';
import { cn } from '../../lib/utils';

/** 模板在浏览器里静态生成，没有接口。 */
export function RateCsvTemplateLink({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() =>
        downloadText(
          rateCsvTemplate.filename,
          rateCsvTemplate.text,
          'text/csv;charset=utf-8',
        )
      }
      className={cn(
        'rounded text-[13px] font-medium text-primary underline-offset-[3px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring',
        className,
      )}
    >
      下载 CSV 模板
    </button>
  );
}
