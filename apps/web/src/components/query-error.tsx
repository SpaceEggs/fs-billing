import { apiProblem, problemNotice } from '../lib/api-problem';
import { CircleAlertIcon } from 'lucide-react';
import { Alert } from './ui/alert';
import { Button } from './ui/button';

/**
 * 数据加载失败（设计稿 1c）：标题说明哪块数据失败。
 * 登录过期与强制改密由全局处理，这里不显示；除 429 外的 4xx 重试不会改变结果，不提供重试。
 */
export function QueryError({
  title,
  error,
  retrying,
  onRetry,
}: {
  title: string;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  const problem = apiProblem(error);
  if (
    problem.kind === 'reauthenticate' ||
    problem.kind === 'password-change-required'
  )
    return null;
  const notice = problemNotice(problem);
  const body =
    problem.kind === 'unavailable'
      ? '服务暂时不可用，请稍后重试'
      : problem.kind === 'forbidden' || problem.kind === 'blocked'
        ? '当前账号无权查看此内容，如有疑问请联系其他管理员'
        : problem.kind === 'not-found'
          ? '内容不存在或已被删除'
          : problem.kind === 'rate-limited'
            ? `${notice.title}，${notice.body}`
            : notice.details?.length
              ? notice.details.join('；')
              : '请求无法完成，请刷新页面后重试';
  const retryable =
    problem.kind === 'unavailable' || problem.kind === 'rate-limited';
  return (
    <Alert
      role="alert"
      className="flex-row items-center gap-3 rounded-xl border-err-border px-[18px] py-4 text-sm"
    >
      <span
        aria-hidden
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-err-soft text-err"
      >
        <CircleAlertIcon className="size-4" />
      </span>
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-[13px] text-muted-foreground">{body}</span>
      </div>
      {retryable ? (
        <Button
          variant="outline"
          size="sm"
          disabled={retrying}
          onClick={onRetry}
        >
          重试
        </Button>
      ) : null}
    </Alert>
  );
}

/** 已有数据时刷新失败：数据照常显示，提示可能不是最新并提供重试；首次加载失败用 QueryError。 */
export function RefreshError({
  title,
  query,
}: {
  title: string;
  query: {
    isError: boolean;
    data: unknown;
    error: unknown;
    isFetching: boolean;
    refetch: () => unknown;
  };
}) {
  if (!query.isError || query.data === undefined) return null;
  return (
    <QueryError
      title={title}
      error={query.error}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
    />
  );
}
