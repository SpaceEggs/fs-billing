import { ApiRequestError } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { CircleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
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
      <Alert variant="error" className="flex items-start">
        <CircleAlertIcon aria-hidden className="mt-px shrink-0" />
        <div className="flex flex-1 flex-col gap-0.5">
          <AlertTitle>网络中断</AlertTitle>
          <AlertDescription>
            {networkMessage ?? '请检查网络后重试'}
          </AlertDescription>
        </div>
        <RefreshButton onRefresh={onRefresh} />
      </Alert>
    );
  const problem = apiProblem(error);
  if (
    problem.kind === 'reauthenticate' ||
    problem.kind === 'password-change-required'
  )
    return null;
  const notice = problemNotice(problem);
  return (
    <Alert variant="error" className="flex items-start">
      <CircleAlertIcon aria-hidden className="mt-px shrink-0" />
      <div className="flex flex-1 flex-col gap-0.5">
        <AlertTitle>{notice.title}</AlertTitle>
        {notice.body ? (
          <AlertDescription>{notice.body}</AlertDescription>
        ) : null}
      </div>
      {notice.refresh ? <RefreshButton onRefresh={onRefresh} /> : null}
    </Alert>
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
      <Alert variant="error">
        <AlertTitle className="col-start-1">{notice.title}</AlertTitle>
        {notice.details?.map((line) => (
          <AlertDescription key={line} className="col-start-1">
            {line}
          </AlertDescription>
        ))}
      </Alert>
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
