import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { downloadText } from '../../lib/download';
import { rateCsvTemplateFor } from '../../lib/rate-csv';
import { useLocale } from '@/i18n';
import { cn } from '../../lib/utils';

/** 模板在浏览器里静态生成，没有接口。 */
export function RateCsvTemplateLink({ className }: { className?: string }) {
  const { t } = useTranslation(['rates']);
  const locale = useLocale();
  return (
    <Button
      variant="link"
      size="inline"
      onClick={() => {
        const template = rateCsvTemplateFor(locale);
        downloadText(
          template.filename,
          template.text,
          'text/csv;charset=utf-8',
        );
      }}
      className={cn(
        'text-[13px] font-medium underline-offset-[3px]',
        className,
      )}
    >
      {t('rates:template.download')}
    </Button>
  );
}
