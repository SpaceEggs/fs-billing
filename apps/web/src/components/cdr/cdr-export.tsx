import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { translate, type Locale } from '@fs-billing/shared';
import { ApiRequestError } from '../../lib/api';
import { apiProblem, issueText, problemNotice } from '../../lib/api-problem';
import { useLocale } from '../../i18n';
import { CircleAlertIcon, DownloadIcon, EllipsisIcon } from 'lucide-react';
import { Button } from '../ui/button';
import { MobileBarButton } from '../mobile-bar-button';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '../ui/alert';

/**
 * 导出的状态：进行中禁用按钮，防止重复点击占满服务端的导出名额；筛选变了就丢掉上一次的错误。
 * 登录过期由全局的 MutationCache 处理，弹出登录过期对话框，登录后回到本页再点一次。
 */
export function useCdrExport(
  run: () => Promise<unknown>,
  /** 导出条件的序列化；变化时清除上一次的错误。 */
  conditionKey: string,
) {
  const mutation = useMutation({ mutationFn: run });
  const failed = useRef(false);
  failed.current = mutation.isError;
  const { reset } = mutation;
  useEffect(() => {
    // 进行中的导出不重置，否则按钮会在下载途中重新可用。
    if (failed.current) reset();
  }, [conditionKey, reset]);
  return mutation;
}

/** 电脑版页头按钮与后台筛选行按钮；手机版门户用顶栏图标，见 CdrExportIcon。 */
export function CdrExportButton({
  label,
  exporting,
  disabled = false,
  title,
  onExport,
  className,
}: {
  label: string;
  exporting: boolean;
  /** 筛选条件不合规时不能导出。 */
  disabled?: boolean;
  /** 置灰时的原因，如「该月话单明细已删除」。 */
  title?: string;
  onExport: () => void;
  className?: string;
}) {
  const { t } = useTranslation(['common', 'cdr']);
  return (
    <Button
      variant="outline"
      disabled={exporting || disabled}
      onClick={onExport}
      {...(title ? { title } : {})}
      className={className}
    >
      {exporting ? t('cdr:export.exporting') : label}
    </Button>
  );
}

/** 手机顶栏的导出图标（设计稿 2d）。 */
export function CdrExportIcon({
  exporting,
  disabled = false,
  onExport,
}: {
  exporting: boolean;
  disabled?: boolean;
  onExport: () => void;
}) {
  const { t } = useTranslation(['common', 'cdr']);
  return (
    <MobileBarButton
      aria-label={
        exporting ? t('cdr:export.exportingShort') : t('cdr:export.csv')
      }
      disabled={exporting || disabled}
      onClick={onExport}
    >
      {exporting ? <EllipsisIcon aria-hidden /> : <DownloadIcon aria-hidden />}
    </MobileBarButton>
  );
}

/** 导出失败说明，在导出按钮旁提供「重试」。400、429、5xx 与网络中断各有说法。 */
export function CdrExportError({
  error,
  retrying,
  onRetry,
}: {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation(['common', 'cdr']);
  const locale = useLocale();
  if (error === null) return null;
  const message = exportFailure(error, locale);
  if (message === null) return null;
  return (
    <Alert
      variant="error"
      className="has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr_auto]"
    >
      <CircleAlertIcon aria-hidden />
      <AlertTitle>{message.title}</AlertTitle>
      {message.body ? (
        <AlertDescription>{message.body}</AlertDescription>
      ) : null}
      <AlertAction>
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          {t('common:action.retry')}
        </Button>
      </AlertAction>
    </Alert>
  );
}

function exportFailure(error: unknown, locale: Locale) {
  if (error instanceof ApiRequestError && error.outcomeUnknown)
    return {
      title: translate(locale, 'cdr:export.interrupted'),
      body: undefined,
    };
  const problem = apiProblem(error);
  if (
    problem.kind === 'reauthenticate' ||
    problem.kind === 'password-change-required'
  )
    return null;
  if (problem.kind === 'validation')
    return {
      title: translate(locale, 'cdr:export.failed'),
      body:
        [...new Set(problem.issues.map((issue) => issueText(issue)))].join(
          translate(locale, 'common:error.listSeparator'),
        ) || translate(locale, 'cdr:export.invalidConditions'),
    };
  const notice = problemNotice(problem);
  return {
    title: translate(locale, 'cdr:export.failedWithReason', {
      reason: notice.title,
    }),
    body: notice.body,
  };
}
