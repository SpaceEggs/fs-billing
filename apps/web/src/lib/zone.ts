import type { Identity } from '@fs-billing/shared';

/** 门户与后台是两个独立区域，各有登录页、首页与主色。 */
export type Zone = 'portal' | 'admin';

export const zones = {
  portal: { home: '/', login: '/login', kind: 'customer' },
  admin: { home: '/admin', login: '/admin/login', kind: 'admin' },
} as const satisfies Record<
  Zone,
  { home: string; login: string; kind: Identity['kind'] }
>;

export function zoneOfPath(pathname: string): Zone {
  return pathname === '/admin' || pathname.startsWith('/admin/')
    ? 'admin'
    : 'portal';
}

export function zoneOfIdentity(identity: Identity): Zone {
  return identity.kind === 'admin' ? 'admin' : 'portal';
}
