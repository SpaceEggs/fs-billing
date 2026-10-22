import { render } from '@testing-library/react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../query-client';
import { createAppRouter } from '../router';

type Reply = {
  status: number;
  body?: unknown;
  /** 文件下载等非 JSON 响应：给出文本与媒体类型，body 被忽略。 */
  file?: { text: string; type: string; disposition?: string };
};
export type ApiHandler = (
  path: string,
  init: RequestInit,
) => Reply | Promise<Reply>;

export const ids = {
  profile: '00000000-0000-4000-8000-000000000001',
  tenant: '00000000-0000-4000-8000-000000000002',
};

export const customerSession = {
  identity: {
    kind: 'customer',
    profileId: ids.profile,
    email: 'abc001@example.com',
    tenant: {
      id: ids.tenant,
      code: 'ABC001',
      name: '深圳市某某科技有限公司',
      currency: 'CNY',
    },
  },
  expiresAt: '2026-10-21T00:00:00.000Z',
  passwordChangeRequired: false,
};

export const adminSession = {
  identity: {
    kind: 'admin',
    profileId: '00000000-0000-4000-8000-000000000009',
    name: '王敏',
    email: 'WangMin@example.com',
  },
  expiresAt: '2026-10-21T00:00:00.000Z',
  passwordChangeRequired: false,
};

export const apiError = (code: string, extra: object = {}) => ({
  error: { code, message: '请求失败', requestId: 'req-test', ...extra },
});

export const page = (items: unknown[], total = items.length) => ({
  items,
  pagination: { page: 1, pageSize: 25, total },
});

export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** 查询缓存与 mutation 缓存里的全部状态（含变量与结果），用来确认凭据没有留在缓存里。 */
export function cachedState(queryClient: QueryClient) {
  return JSON.stringify([
    queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.state),
    queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
  ]);
}

type Call = { path: string; method: string; body: unknown };

/** 记录请求并按 “METHOD 路径” 前缀应答；会话默认是管理员。 */
export function adminApi(
  routes: Record<string, ApiHandler>,
  session: object = adminSession,
) {
  const calls: Call[] = [];
  const handler: ApiHandler = (path, init) => {
    const method = init.method ?? 'GET';
    calls.push({
      path,
      method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (path === '/api/auth/session') return { status: 200, body: session };
    const pathname = path.split('?')[0];
    const route = routes[`${method} ${pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(path, init);
  };
  return { calls, handler };
}

/** 用内存路由渲染完整应用，fetch 由测试按路径应答。 */
export function renderApp(path: string, handler: ApiHandler) {
  const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
    const reply = await handler(input, init);
    if (reply.file)
      return new Response(reply.file.text, {
        status: reply.status,
        headers: {
          'content-type': reply.file.type,
          ...(reply.file.disposition
            ? { 'content-disposition': reply.file.disposition }
            : {}),
        },
      });
    return new Response(
      reply.body === undefined ? null : JSON.stringify(reply.body),
      {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const queryClient = createQueryClient();
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(queryClient, history);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const location = () =>
    `${router.state.location.pathname}${router.state.location.searchStr}`;
  return { router, fetchMock, location, queryClient };
}
