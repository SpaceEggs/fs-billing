import { ApiRequestError } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { Button } from '../ui/button';

/**
 * 写操作失败的说明。登录过期与强制改密由全局处理，这里不显示；
 * 网络中断时结果未知，用 `networkMessage` 提示先核实再重试；数据过时的冲突提供“刷新”。
 */
export function ProblemAlert({
  error,
  networkMessage,
  onRefresh,
}: {
  error: unknown;
  networkMessage?: string;
  onRefresh?: () => void;
}) {
  if (error instanceof ApiRequestError && error.status === 0)
    return (
      <div
        role="alert"
        className="rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
      >
        <span className="font-semibold">网络中断</span>
        <span className="block">{networkMessage ?? '请检查网络后重试'}</span>
      </div>
    );
  const problem = apiProblem(error);
  if (
    problem.kind === 'reauthenticate' ||
    problem.kind === 'password-change-required'
  )
    return null;
  const notice = problemNotice(problem);
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
    >
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">{notice.title}</span>
        {notice.body ? <span>{notice.body}</span> : null}
      </div>
      {notice.refresh && onRefresh ? (
        <Button variant="outline" size="sm" onClick={onRefresh}>
          刷新
        </Button>
      ) : null}
    </div>
  );
}
