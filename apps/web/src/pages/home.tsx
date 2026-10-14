import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { Identity } from '@fs-billing/shared';
import { AppShell, PageBody } from '../components/app-shell';
import { Money } from '../components/data-format';
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

export function PortalHome({ identity }: { identity: Identity }) {
  const context = useQuery({
    queryKey: ['portal', 'context'],
    queryFn: () => callApi('portalContext'),
  });
  const blocked = blockedCode(context.error);
  if (blocked) return <BlockedPage zone="portal" code={blocked} />;
  const crumb =
    identity.kind === 'customer'
      ? `${identity.tenant.code} · ${identity.tenant.name}`
      : '';
  return (
    <AppShell identity={identity} title="首页" crumb={crumb} activeNav="首页">
      <PageBody title="首页">
        {loadFailure(context) ?? (
          <div className="grid gap-4 md:grid-cols-3">
            <section
              aria-label="当前余额"
              className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
            >
              <span className="text-[13px] text-muted-foreground">
                当前余额
              </span>
              {context.data ? (
                <Money
                  value={context.data.balance}
                  className="text-[32px] leading-tight font-semibold"
                />
              ) : (
                <span className="h-10 w-40 animate-pulse rounded-md bg-skeleton" />
              )}
              <span className="text-xs text-muted-foreground">
                {context.data?.balance.currency ?? ' '}
              </span>
            </section>
          </div>
        )}
        <p className="m-0 text-sm text-muted-foreground">
          话单、月账单与余额流水将在后续版本开放。
        </p>
      </PageBody>
    </AppShell>
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
            {context.data
              ? `欢迎，${context.data.identity.name}。租户、待收款等后台功能将在后续版本开放。`
              : ' '}
          </p>
        )}
      </PageBody>
    </AppShell>
  );
}
