import type { RegisteredRouter, RouteIds } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { zoneOfIdentity, zones, type Zone } from './zone';

const storageKey = 'fs-billing.return-to';
const origin = 'http://fs-billing.invalid';

/** sessionStorage 不可用（隐私模式、被禁用）时退回本页内存，不打断登录流程。 */
let memoryPath: string | null = null;

function browserStorage(): Storage | null {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

/** 只在本地保存站内路径，API 不接收也不回显返回地址。 */
export function rememberReturnPath(
  path: string,
  storage: Storage | null = browserStorage(),
) {
  memoryPath = path;
  try {
    storage?.setItem(storageKey, path);
  } catch {
    // 已保存在内存中。
  }
}

export function takeReturnPath(storage: Storage | null = browserStorage()) {
  const remembered = memoryPath;
  memoryPath = null;
  let stored: string | null = null;
  try {
    stored = storage?.getItem(storageKey) ?? null;
  } catch {
    // 使用内存中的路径。
  }
  try {
    storage?.removeItem(storageKey);
  } catch {
    // 清除失败不影响本次登录。
  }
  return remembered ?? stored;
}

/**
 * 按路由器自己的匹配规则（解码、忽略大小写、末尾斜杠）判断路径落在哪个区域、
 * 是否是登录页，避免校验与实际渲染的页面不一致。
 */
function routeOf(
  router: RegisteredRouter,
  url: URL,
): { zone: Zone; login: boolean } {
  const location = router.parseLocation({
    href: `${url.pathname}${url.search}${url.hash}`,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    state: { __TSR_index: 0 },
  });
  const matches = router.matchRoutes(location);
  const matched = (id: RouteIds<RegisteredRouter['routeTree']>) =>
    matches.some((match) => match.routeId === id);
  return {
    zone: matched('/admin') ? 'admin' : 'portal',
    login: matched('/login') || matched('/admin/login'),
  };
}

/**
 * 校验登录前保存的路径是否可以返回：必须是本站绝对路径，
 * 属于登录身份的区域，且不是登录页；否则回到该身份的首页。
 */
export function resolveReturnPath(
  candidate: string | null,
  identity: Identity,
  router: RegisteredRouter,
) {
  const zone = zoneOfIdentity(identity);
  const home = zones[zone].home;
  if (!candidate || !candidate.startsWith('/') || /^\/[/\\]/.test(candidate))
    return home;
  if (/[\\\p{Cc}]/u.test(candidate)) return home;
  try {
    const url = new URL(candidate, origin);
    if (url.origin !== origin || /^\/[/\\]/.test(url.pathname)) return home;
    const route = routeOf(router, url);
    if (route.zone !== zone || route.login) return home;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return home;
  }
}
