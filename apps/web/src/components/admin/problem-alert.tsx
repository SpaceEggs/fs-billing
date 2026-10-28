import { ApiRequestError } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { CalloutIcon } from '../ui/alert';
import { Button } from '../ui/button';

/**
 * 写操作失败的说明。登录过期与强制改密由全局处理，这里不显示；
 * 网络中断时结果未知，用 `networkMessage` 提示先核实再重试；结果未知与数据过时的冲突都提供“刷新”。
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
  if (error instanceof ApiRequestError && error.outcomeUnknown)
    return (
      <div
        role="alert"
        className="flex items-start gap-2.5 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
      >
        <CalloutIcon tone="err" />
        <div className="flex flex-1 flex-col gap-0.5">
          <span className="font-semibold">网络中断</span>
          <span>{networkMessage ?? '请检查网络后重试'}</span>
        </div>
        <RefreshButton onRefresh={onRefresh} />
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
      className="flex items-start gap-2.5 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
    >
      <CalloutIcon tone="err" />
      <div className="flex flex-1 flex-col gap-0.5">
        <span className="font-semibold">{notice.title}</span>
        {notice.body ? <span>{notice.body}</span> : null}
      </div>
      {notice.refresh ? <RefreshButton onRefresh={onRefresh} /> : null}
    </div>
  );
}

function RefreshButton({ onRefresh }: { onRefresh: (() => void) | undefined }) {
  return onRefresh ? (
    <Button variant="outline" size="sm" onClick={onRefresh}>
      刷新
    </Button>
  ) : null;
}

/** 校验失败时逐条列出服务端说明（ProblemAlert 只显示标题）。一次超过 500 条的分批提示走这里。 */
export function RequestFailure({
  error,
  networkMessage,
  onRefresh,
}: {
  error: unknown;
  networkMessage?: string;
  onRefresh?: () => void;
}) {
  const problem = apiProblem(error);
  if (problem.kind === 'validation') {
    const notice = problemNotice(problem);
    return (
      <div
        role="alert"
        className="flex flex-col gap-0.5 rounded-lg border border-err-border bg-err-soft px-3 py-2.5 text-[13px] text-err"
      >
        <span className="font-semibold">{notice.title}</span>
        {notice.details?.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    );
  }
  return (
    <ProblemAlert
      error={error}
      {...(networkMessage !== undefined ? { networkMessage } : {})}
      {...(onRefresh ? { onRefresh } : {})}
    />
  );
}
