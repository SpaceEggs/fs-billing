import { useTranslation } from 'react-i18next';
import { translate } from '@fs-billing/shared';
import { Badge } from './ui/badge';
import type { Zone } from '../lib/zone';
import { cn } from '../lib/utils';

/**
 * 品牌行里的产品名。`productLabel` 固定为中文，供尚未迁移的登录页拼接；
 * BrandRow、SidebarBrand 按界面语言显示。
 */
export const productLabel = {
  portal: translate('zh', 'shell:product.portal'),
  admin: translate('zh', 'shell:product.admin'),
} as const satisfies Record<Zone, string>;

export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-[15px] font-bold text-primary-foreground',
        className,
      )}
    >
      F
    </span>
  );
}

export function AdminPill({ children }: { children: React.ReactNode }) {
  return (
    <Badge variant="brand" className="h-6 rounded-full px-2.5 font-semibold">
      {children}
    </Badge>
  );
}

/** 登录页电脑版顶部品牌行。 */
export function BrandRow({ zone }: { zone: Zone }) {
  const { t } = useTranslation(['shell']);
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <span className="text-base font-semibold">FS-Billing</span>
      {zone === 'admin' ? (
        <AdminPill>{t('shell:product.admin')}</AdminPill>
      ) : (
        <span className="border-l border-border pl-2.5 text-[13px] text-muted-foreground">
          {t('shell:product.portal')}
        </span>
      )}
    </div>
  );
}

/** 侧栏与抽屉顶部的品牌块。 */
export function SidebarBrand({ zone }: { zone: Zone }) {
  const { t } = useTranslation(['shell']);
  return (
    <div className="flex items-center gap-2.5 px-2 py-1">
      <LogoMark className="size-7 rounded-[7px] text-[13px]" />
      <div className="flex flex-col">
        <span className="text-sm font-semibold">FS-Billing</span>
        <span
          className={cn(
            'text-[11px]',
            zone === 'admin'
              ? 'font-medium text-primary'
              : 'text-muted-foreground',
          )}
        >
          {t(`shell:product.${zone}` as 'shell:product.admin')}
        </span>
      </div>
    </div>
  );
}
