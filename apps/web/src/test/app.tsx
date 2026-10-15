import { render } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../query-client';
import { createAppRouter } from '../router';

type Reply = { status: number; body?: unknown };
export type ApiHandler = (path: string, init: RequestInit) => Reply;

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

export const apiError = (code: string, extra: object = {}) => ({
  error: { code, message: '请求失败', requestId: 'req-test', ...extra },
});

/** 用内存路由渲染完整应用，fetch 由测试按路径应答。 */
export function renderApp(path: string, handler: ApiHandler) {
  const fetchMock = vi.fn((input: string, init: RequestInit = {}) => {
    const reply = handler(input, init);
    return Promise.resolve(
      new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        },
      ),
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
  return { router, fetchMock, location };
}
