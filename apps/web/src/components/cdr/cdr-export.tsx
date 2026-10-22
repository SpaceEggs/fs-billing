import { useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiRequestError } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { Button } from '../ui/button';
import { CalloutIcon } from '../ui/alert';

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
  onExport,
  className,
}: {
  label: string;
  exporting: boolean;
  /** 筛选条件不合规时不能导出。 */
  disabled?: boolean;
  onExport: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      disabled={exporting || disabled}
      onClick={onExport}
      className={className}
    >
      {exporting ? '正在导出…' : label}
    </Button>
  );
}

/** 手机顶栏的 ⤓（设计稿 2d）。 */
export function CdrExportIcon({
  exporting,
  disabled = false,
  onExport,
  className,
}: {
  exporting: boolean;
  disabled?: boolean;
  onExport: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={exporting ? '正在导出' : '导出 CSV'}
      disabled={exporting || disabled}
      onClick={onExport}
      className={className}
    >
      {exporting ? '…' : '⤓'}
    </button>
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
  if (error === null) return null;
  const message = exportFailure(error);
  if (message === null) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
    >
      <CalloutIcon tone="err" />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">{message.title}</span>
        {message.body ? <span>{message.body}</span> : null}
      </div>
      <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
        重试
      </Button>
    </div>
  );
}

function exportFailure(error: unknown) {
  if (error instanceof ApiRequestError && error.outcomeUnknown)
    return { title: '导出中断，请重试', body: undefined };
  const problem = apiProblem(error);
  if (
    problem.kind === 'reauthenticate' ||
    problem.kind === 'password-change-required'
  )
    return null;
  if (problem.kind === 'validation')
    return {
      title: '导出失败',
      body:
        [...new Set(problem.issues.map((issue) => issue.message))].join('；') ||
        '导出条件有误',
    };
  const notice = problemNotice(problem);
  return { title: `导出失败：${notice.title}`, body: notice.body };
}
