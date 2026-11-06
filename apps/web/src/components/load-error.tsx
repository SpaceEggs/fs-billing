import { useTranslation } from 'react-i18next';
import { ApiRequestError } from '../lib/api';
import { CircleAlertIcon } from 'lucide-react';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

/** 数据加载失败：4xx 重试不会改变结果，只说明原因；网络或服务器错误提供重试。 */
export function LoadError({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation(['common']);
  const forbidden = error instanceof ApiRequestError && error.status === 403;
  const retryable = !(
    error instanceof ApiRequestError &&
    error.status >= 400 &&
    error.status < 500
  );
  return (
    <Alert
      role="alert"
      className="items-center gap-2 rounded-xl px-6 py-10 text-center text-base"
    >
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <CircleAlertIcon className="size-5" />
      </span>
      <span className="text-base font-semibold">
        {forbidden ? t('error.loadForbiddenTitle') : t('error.loadFailedTitle')}
      </span>
      <span className="text-sm text-muted-foreground">
        {forbidden
          ? t('error.loadForbiddenBody')
          : retryable
            ? t('error.loadNetworkBody')
            : t('error.loadRequestBody')}
      </span>
      {retryable ? (
        <Button
          variant="outline"
          className="mt-2"
          disabled={retrying}
          onClick={onRetry}
        >
          {t('action.retry')}
        </Button>
      ) : null}
    </Alert>
  );
}
