import { Button } from '../ui/button';
import { downloadText } from '../../lib/download';
import { rateCsvTemplate } from '../../lib/rate-csv';
import { cn } from '../../lib/utils';

/** 模板在浏览器里静态生成，没有接口。 */
export function RateCsvTemplateLink({ className }: { className?: string }) {
  return (
    <Button
      variant="link"
      size="inline"
      onClick={() =>
        downloadText(
          rateCsvTemplate.filename,
          rateCsvTemplate.text,
          'text/csv;charset=utf-8',
        )
      }
      className={cn(
        'text-[13px] font-medium underline-offset-[3px]',
        className,
      )}
    >
      下载 CSV 模板
    </Button>
  );
}
