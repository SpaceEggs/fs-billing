import type { Zone } from '../lib/zone';
import { cn } from '../lib/utils';

export const productLabel = {
  portal: '客户门户',
  admin: '管理后台',
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
    <span className="flex h-6 items-center rounded-full border border-brand-border bg-brand-soft px-2.5 text-xs font-semibold text-primary">
      {children}
    </span>
  );
}

/** 登录页电脑版顶部品牌行。 */
export function BrandRow({ zone }: { zone: Zone }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark />
      <span className="text-base font-semibold">FS-Billing</span>
      {zone === 'admin' ? (
        <AdminPill>{productLabel.admin}</AdminPill>
      ) : (
        <span className="border-l border-border pl-2.5 text-[13px] text-muted-foreground">
          {productLabel.portal}
        </span>
      )}
    </div>
  );
}

/** 侧栏与抽屉顶部的品牌块。 */
export function SidebarBrand({ zone }: { zone: Zone }) {
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
          {productLabel[zone]}
        </span>
      </div>
    </div>
  );
}
