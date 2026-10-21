import type { Currency, Identity } from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { ThemeSegmented } from '../../components/theme-controls';
import { Button } from '../../components/ui/button';
import { logoutFailedMessage, useLogout } from '../../lib/use-logout';
import { ChangePasswordForm } from '../change-password';

const currencyLabel = {
  CNY: 'CNY 人民币',
  USD: 'USD 美元',
} as const satisfies Record<Currency, string>;

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        {description ? (
          <span className="text-[13px] text-muted-foreground">
            {description}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** 账号设置（设计稿第三批 2a 至 2e）：只读账号信息、修改密码、主题、退出登录。 */
export function PortalSettingsPage({ identity }: { identity: Identity }) {
  const logout = useLogout('portal');
  if (identity.kind !== 'customer') return null;
  const { tenant } = identity;
  return (
    <AppShell
      identity={identity}
      title="账号设置"
      crumb={`${tenant.code} · ${tenant.name}`}
      activeNav="账号设置"
    >
      <PageBody title="账号设置">
        <div className="flex max-w-[760px] flex-col gap-5">
          <Card
            title="账号信息"
            description="以下信息由管理员设置，如需修改请联系客服"
          >
            <dl className="m-0 grid grid-cols-[88px_1fr] text-sm md:grid-cols-[120px_1fr]">
              <dt className="border-b border-border py-3 text-muted-foreground">
                登录邮箱
              </dt>
              <dd className="m-0 border-b border-border py-3 break-all">
                {identity.email}
              </dd>
              <dt className="border-b border-border py-3 text-muted-foreground">
                租户
              </dt>
              <dd className="m-0 flex flex-wrap items-center gap-2 border-b border-border py-3">
                {tenant.name}
                <span className="inline-flex h-[22px] items-center rounded-md bg-muted px-2 font-mono text-xs">
                  {tenant.code}
                </span>
              </dd>
              <dt className="py-3 text-muted-foreground">币种</dt>
              <dd className="m-0 py-3">{currencyLabel[tenant.currency]}</dd>
            </dl>
          </Card>
          <Card title="修改密码" description="修改后，其他设备上的登录将失效">
            <div className="md:w-[360px]">
              <ChangePasswordForm forced={false} />
            </div>
          </Card>
          <Card title="主题">
            <ThemeSegmented className="self-start" />
          </Card>
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <Button
              variant="outline"
              className="self-start text-neg"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              退出登录
            </Button>
            {logout.isError ? (
              <p role="alert" className="m-0 text-sm text-neg">
                {logoutFailedMessage}
              </p>
            ) : null}
          </div>
        </div>
      </PageBody>
    </AppShell>
  );
}
