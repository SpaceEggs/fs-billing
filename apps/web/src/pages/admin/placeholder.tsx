import type { Identity } from '@fs-billing/shared';
import { AppShell, PageBody, type NavLabel } from '../../components/app-shell';

/** 阶段 5 尚未实现的后台页面：导航与路由已就位，内容随后续交付。 */
export function AdminPlaceholderPage({
  identity,
  title,
  crumb,
  activeNav,
}: {
  identity: Identity;
  title: string;
  crumb: string;
  activeNav: NavLabel;
}) {
  return (
    <AppShell
      identity={identity}
      title={title}
      crumb={crumb}
      activeNav={activeNav}
    >
      <PageBody title={title}>
        <p className="m-0 text-sm text-muted-foreground">该页面即将开放。</p>
      </PageBody>
    </AppShell>
  );
}
