import { cn } from '@/lib/utils';
import { Card as UiCard } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { translate, type Currency, type Identity } from '@fs-billing/shared';
import { Badge } from '../../components/ui/badge';
import { AppShell, PageBody } from '../../components/app-shell';
import { ThemeSegmented } from '../../components/theme-controls';
import { Button } from '../../components/ui/button';
import { useLocale } from '../../i18n';
import { logoutFailedMessage, useLogout } from '../../lib/use-logout';
import { ChangePasswordForm } from '../change-password';

const currencyLabel = {
  CNY: 'portal:settings.currencyNames.CNY',
  USD: 'portal:settings.currencyNames.USD',
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
    <UiCard
      asChild
      className={cn(
        'block gap-0 bg-transparent py-0 text-inherit shadow-none',
        'flex flex-col gap-4 rounded-xl border border-border bg-card p-5',
      )}
    >
      <section aria-label={title}>
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
    </UiCard>
  );
}

/** 账号设置（设计稿第三批 2a 至 2e）：只读账号信息、修改密码、主题、退出登录。 */
export function PortalSettingsPage({ identity }: { identity: Identity }) {
  const { t } = useTranslation(['portal', 'auth', 'common']);
  const locale = useLocale();
  const logout = useLogout('portal');
  if (identity.kind !== 'customer') return null;
  const { tenant } = identity;
  return (
    <AppShell
      identity={identity}
      title={t('portal:settings.title')}
      crumb={`${tenant.code} · ${tenant.name}`}
      activeNav={translate('zh', 'shell:nav.settings')}
    >
      <PageBody title={t('portal:settings.title')}>
        <div className="flex max-w-[760px] flex-col gap-5">
          <Card
            title={t('portal:settings.info')}
            description={t('portal:settings.infoHint')}
          >
            <dl className="m-0 grid grid-cols-[88px_1fr] text-sm md:grid-cols-[120px_1fr]">
              <dt className="border-b border-border py-3 text-muted-foreground">
                {t('portal:settings.email')}
              </dt>
              <dd className="m-0 border-b border-border py-3 break-all">
                {identity.email}
              </dd>
              <dt className="border-b border-border py-3 text-muted-foreground">
                {t('portal:settings.tenant')}
              </dt>
              <dd className="m-0 flex flex-wrap items-center gap-2 border-b border-border py-3">
                {tenant.name}
                <Badge
                  variant="secondary"
                  className="border-transparent font-mono"
                >
                  {tenant.code}
                </Badge>
              </dd>
              <dt className="py-3 text-muted-foreground">
                {t('portal:settings.currency')}
              </dt>
              <dd className="m-0 py-3">
                {translate(locale, currencyLabel[tenant.currency])}
              </dd>
            </dl>
          </Card>
          <Card
            title={t('auth:changePassword.title.normal')}
            description={t('auth:changePassword.description.normal')}
          >
            <div className="md:w-[360px]">
              <ChangePasswordForm forced={false} />
            </div>
          </Card>
          <Card title={t('portal:settings.theme')}>
            <ThemeSegmented className="self-start" />
          </Card>
          <div className="flex flex-col gap-2 border-t border-border pt-5">
            <Button
              variant="outline"
              className="self-start text-neg"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              {t('common:account.signOut')}
            </Button>
            {logout.isError ? (
              <p role="alert" className="m-0 text-sm text-neg">
                {logoutFailedMessage()}
              </p>
            ) : null}
          </div>
        </div>
      </PageBody>
    </AppShell>
  );
}
