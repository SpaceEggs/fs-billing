import type { Identity } from '@fs-billing/shared';
import { zoneOfIdentity, zoneOfPath, zones } from './zone';

const storageKey = 'fs-billing.return-to';

/** 只在本地保存站内路径，API 不接收也不回显返回地址。 */
export function rememberReturnPath(
  path: string,
  storage: Storage = sessionStorage,
) {
  storage.setItem(storageKey, path);
}

export function takeReturnPath(storage: Storage = sessionStorage) {
  const path = storage.getItem(storageKey);
  storage.removeItem(storageKey);
  return path;
}

/**
 * 校验登录前保存的路径是否可以返回：必须是本站绝对路径，
 * 属于登录身份的区域，且不是登录页；否则回到该身份的首页。
 */
export function resolveReturnPath(
  candidate: string | null,
  identity: Identity,
) {
  const zone = zoneOfIdentity(identity);
  const home = zones[zone].home;
  if (!candidate || !candidate.startsWith('/') || /^\/[/\\]/.test(candidate))
    return home;
  if (/[\\\p{Cc}]/u.test(candidate)) return home;
  let url: URL;
  try {
    url = new URL(candidate, 'http://fs-billing.invalid');
  } catch {
    return home;
  }
  if (url.origin !== 'http://fs-billing.invalid') return home;
  if (zoneOfPath(url.pathname) !== zone) return home;
  if (url.pathname === zones.portal.login || url.pathname === zones.admin.login)
    return home;
  return `${url.pathname}${url.search}${url.hash}`;
}
