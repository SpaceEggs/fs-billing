import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { AppShell, PageBody } from '../components/app-shell';
import { LoadError } from '../components/load-error';
import { callApi, needsReauthentication } from '../lib/api';
import { blockedCode } from '../lib/session';
import { BlockedPage } from './blocked';

/** 401 reauthenticate 由登录过期对话框处理，其余失败在页面内显示。 */
function loadFailure(query: UseQueryResult) {
  if (!query.isError || needsReauthentication(query.error)) return null;
  return (
    <LoadError
      error={query.error}
      retrying={query.isFetching}
      onRetry={() => void query.refetch()}
    />
  );
}

export function AdminHome({ identity }: { identity: Identity }) {
  const context = useQuery({
    queryKey: ['admin', 'context'],
    queryFn: () => callApi('adminContext'),
  });
  const blocked = blockedCode(context.error);
  if (blocked) return <BlockedPage zone="admin" code={blocked} />;
  return (
    <AppShell identity={identity} title="概览" crumb="概览" activeNav="概览">
      <PageBody title="概览">
        {loadFailure(context) ?? (
          <p className="m-0 text-sm text-muted-foreground">
            {context.data ? (
              <>
                欢迎，{context.data.identity.name}。可在
                <Link to="/admin/tenants" className="text-primary">
                  租户
                </Link>
                、
                <Link to="/admin/receivables" className="text-primary">
                  待收款
                </Link>
                和
                <Link to="/admin/admins" className="text-primary">
                  管理员
                </Link>
                中开展工作；概览指标与需要关注的事项将在后续版本开放。
              </>
            ) : (
              ' '
            )}
          </p>
        )}
      </PageBody>
    </AppShell>
  );
}
