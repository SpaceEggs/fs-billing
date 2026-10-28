import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminCdrDeletionMonth } from '@fs-billing/shared';
import { apiError } from '../../test/app';
import { CdrDeleteDialog } from './cdr-delete-dialog';

const tenant = {
  id: '00000000-0000-4000-8000-00000000a001',
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY' as const,
  balance: '-35.2',
  createdAt: '2026-08-12T02:31:02.000Z',
};

const statementId = '00000000-0000-4000-8000-0000000000b1';
const auditId = '00000000-0000-4000-8000-0000000000c1';

const failureMessage = '服务内部错误，已删除的月份保留，请稍后重试剩余月份';

function monthRow(
  month: string,
  state: AdminCdrDeletionMonth['state'],
  extra: Partial<AdminCdrDeletionMonth> = {},
): AdminCdrDeletionMonth {
  return {
    month,
    state,
    cdrCount: null,
    blockedReasons: [],
    statementId: null,
    deleted: null,
    ...extra,
  };
}

function defaultMonths(
  over: Record<string, Partial<AdminCdrDeletionMonth>> = {},
) {
  const specs: Array<
    [string, AdminCdrDeletionMonth['state'], Partial<AdminCdrDeletionMonth>]
  > = [
    ['2026-01', 'before_opening', {}],
    ['2026-02', 'before_opening', {}],
    [
      '2026-03',
      'blocked',
      {
        cdrCount: 3,
        blockedReasons: ['reconcile_not_ok', 'uncharged_calls'],
      },
    ],
    [
      '2026-04',
      'blocked',
      { cdrCount: 4, blockedReasons: ['reconcile_not_ok'] },
    ],
    ['2026-05', 'deleted', { deleted: { at: null, by: null } }],
    [
      '2026-06',
      'blocked',
      { cdrCount: 6, blockedReasons: ['uncharged_calls'] },
    ],
    ['2026-07', 'no_statement', {}],
    ['2026-08', 'deletable', { cdrCount: 9642, statementId }],
    ['2026-09', 'no_statement', {}],
    ['2026-10', 'no_statement', {}],
    ['2026-11', 'future', {}],
    ['2026-12', 'future', {}],
  ];
  return specs.map(([month, state, extra]) =>
    monthRow(month, state, { ...extra, ...over[month] }),
  );
}

function deletedBody(
  months: Array<{ month: string; deleted: number }>,
  total: number,
  failure: { month: string; message: string } | null = null,
) {
  return {
    months: months.map((row) => ({
      ...row,
      statementId,
      auditId,
    })),
    total,
    remaining: failure ? [failure.month] : [],
    failure: failure
      ? {
          month: failure.month,
          code: 'INTERNAL' as const,
          message: failure.message,
        }
      : null,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function renderDialog(handlers?: {
  months?: () => AdminCdrDeletionMonth[];
  post?: (call: number) => { status: number; body: unknown };
}) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') {
        const year = Number(
          new URL(path, 'http://localhost').searchParams.get('year'),
        );
        return Promise.resolve(
          json(200, {
            tenant: {
              id: tenant.id,
              code: tenant.code,
              name: tenant.name,
            },
            year,
            months: handlers?.months?.() ?? defaultMonths(),
          }),
        );
      }
      posts.push(JSON.parse(init.body as string));
      const reply = handlers?.post?.(posts.length) ?? {
        status: 200,
        body: deletedBody([{ month: '2026-08', deleted: 9642 }], 9642),
      };
      return Promise.resolve(json(reply.status, reply.body));
    }),
  );
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <CdrDeleteDialog tenant={tenant} open onOpenChange={() => {}} />
    </QueryClientProvider>,
  );
  return { posts };
}

beforeEach(() => {
  // 北京时间 2026-10-28 14:00。10 月是当前月。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-28T06:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name }));
}

describe('cdr delete dialog', () => {
  it('disables the current, unsettled, future, and other non-deletable months', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(
      await screen.findByRole('button', { name: '开始月份：选择月份' }),
    );
    const dialog = screen.getByRole('dialog', { name: '删除话单' });
    const month = (name: string) =>
      within(dialog).getByRole('button', { name });
    expect(
      await screen.findByRole('button', { name: '2026年8月，9,642 条' }),
    ).toBeEnabled();
    expect(
      month('2026年10月，账单未生成，本月账单尚未生成，不可选'),
    ).toBeDisabled();
    expect(
      month('2026年9月，账单未生成，本月账单尚未生成，不可选'),
    ).toBeDisabled();
    expect(month('2026年11月，尚未到达')).toBeDisabled();
    expect(month('2026年2月，未开户')).toBeDisabled();
    expect(month('2026年5月，已删除，该月话单已删除')).toBeDisabled();
    expect(month('2026年4月，账单待重新生成')).toBeDisabled();
    expect(month('2026年6月，有话单尚未扣费')).toBeDisabled();
    expect(month('2026年3月，账单待重新生成、有话单尚未扣费')).toBeDisabled();
  });

  it('previews the count and range, then deletes only after the exact code', async () => {
    const user = userEvent.setup();
    const { posts } = renderDialog();
    await user.click(
      await screen.findByRole('button', { name: '开始月份：选择月份' }),
    );
    await choose(user, '2026年8月，9,642 条');
    const range = screen.getByText(
      '时间范围 2026-08-12 00:00:00 至 2026-08-31 23:59:59（北京时间）',
    );
    expect(range.parentElement).toHaveTextContent(
      '将删除 ABC001 在 2026年8月 的 9,642 条话单',
    );
    expect(range).toBeVisible();
    expect(
      screen.getByText(/原始 JSON 不随删除话单清除，按归档策略老化/),
    ).toBeVisible();
    const submit = screen.getByRole('button', { name: '删除 9,642 条话单' });
    expect(submit).toBeDisabled();
    const code = screen.getByRole('textbox', { name: /请输入租户编码/ });
    await user.type(code, 'abc001');
    expect(screen.getByText('编码不一致，请输入 ABC001')).toBeVisible();
    expect(submit).toBeDisabled();
    await user.clear(code);
    await user.type(code, 'ABC');
    expect(screen.getByText('继续输入…')).toBeVisible();
    expect(submit).toBeDisabled();
    await user.type(code, '001');
    expect(screen.getByText('✓ 编码正确')).toBeVisible();
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(
      await screen.findByRole('heading', { name: '已删除 9,642 条话单' }),
    ).toBeVisible();
    expect(
      screen.getByText('ABC001 · 2026年8月（2026-08-12 至 2026-08-31）'),
    ).toBeVisible();
    expect(
      screen.getByText(/余额 -¥35\.20 和 2026年8月 月账单不受影响/),
    ).toBeVisible();
    expect(posts).toEqual([
      {
        fromMonth: '2026-08',
        toMonth: '2026-08',
        tenantCode: 'ABC001',
        expectedCount: 9642,
      },
    ]);
  });

  it('refuses a range that contains a month that cannot be deleted', async () => {
    const user = userEvent.setup();
    const { posts } = renderDialog({
      months: () =>
        defaultMonths({
          '2026-06': {
            state: 'deletable',
            cdrCount: 10,
            blockedReasons: [],
          },
        }),
    });
    await user.click(
      await screen.findByRole('button', { name: '开始月份：选择月份' }),
    );
    await choose(user, '2026年6月，10 条');
    await user.click(
      screen.getByRole('button', { name: '结束月份：2026年6月' }),
    );
    await choose(user, '2026年8月，9,642 条');
    expect(
      screen.getByText('2026年7月不可选：本月账单尚未生成，不可选'),
    ).toBeVisible();
    await user.type(
      screen.getByRole('textbox', { name: /请输入租户编码/ }),
      'ABC001',
    );
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /删除 .+ 条话单/ })).toBeNull();
    expect(posts).toEqual([]);
  });

  it('refetches the preview when the deleted count changed', async () => {
    const user = userEvent.setup();
    let count = 9642;
    const { posts } = renderDialog({
      months: () => defaultMonths({ '2026-08': { cdrCount: count } }),
      post: (call) => {
        if (call === 1) {
          count = 9700;
          return { status: 409, body: apiError('CDR_DELETE_COUNT_CHANGED') };
        }
        return {
          status: 200,
          body: deletedBody([{ month: '2026-08', deleted: 9700 }], 9700),
        };
      },
    });
    await user.click(
      await screen.findByRole('button', { name: '开始月份：选择月份' }),
    );
    await choose(user, '2026年8月，9,642 条');
    await user.type(
      screen.getByRole('textbox', { name: /请输入租户编码/ }),
      'ABC001',
    );
    await user.click(screen.getByRole('button', { name: '删除 9,642 条话单' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '话单条数与预览不符，请刷新后重新预览',
    );
    const again = await screen.findByRole('button', {
      name: '删除 9,700 条话单',
    });
    await waitFor(() => expect(again).toBeEnabled());
    expect(
      screen.getByText(/时间范围 2026-08-12/).parentElement,
    ).toHaveTextContent('将删除 ABC001 在 2026年8月 的 9,700 条话单');
    await user.click(again);
    expect(
      await screen.findByRole('heading', { name: '已删除 9,700 条话单' }),
    ).toBeVisible();
    expect(posts).toEqual([
      {
        fromMonth: '2026-08',
        toMonth: '2026-08',
        tenantCode: 'ABC001',
        expectedCount: 9642,
      },
      {
        fromMonth: '2026-08',
        toMonth: '2026-08',
        tenantCode: 'ABC001',
        expectedCount: 9700,
      },
    ]);
  });

  it('lists the remaining months after a partial failure and retries them', async () => {
    const user = userEvent.setup();
    let deletedAugust = false;
    const { posts } = renderDialog({
      months: () =>
        defaultMonths({
          '2026-08': deletedAugust
            ? {
                state: 'deleted',
                cdrCount: 9642,
                deleted: { at: null, by: null },
              }
            : { state: 'deletable', cdrCount: 9642, statementId },
          '2026-09': { state: 'deletable', cdrCount: 500, statementId },
        }),
      post: (call) => {
        if (call === 1) {
          deletedAugust = true;
          return {
            status: 200,
            body: deletedBody([{ month: '2026-08', deleted: 9642 }], 9642, {
              month: '2026-09',
              message: failureMessage,
            }),
          };
        }
        return {
          status: 200,
          body: deletedBody([{ month: '2026-09', deleted: 500 }], 500),
        };
      },
    });
    await user.click(
      await screen.findByRole('button', { name: '开始月份：选择月份' }),
    );
    await choose(user, '2026年8月，9,642 条');
    await user.click(
      screen.getByRole('button', { name: '结束月份：2026年8月' }),
    );
    await choose(user, '2026年9月，500 条');
    expect(
      screen.getByText(/时间范围 2026-08-12/).parentElement,
    ).toHaveTextContent(
      '将删除 ABC001 在 2026年8月 至 2026年9月 的 10,142 条话单',
    );
    expect(screen.getByText(/时间范围 2026-08-12/)).toHaveTextContent(
      '2026-08-12 00:00:00 至 2026-09-30 23:59:59（北京时间）',
    );
    await user.type(
      screen.getByRole('textbox', { name: /请输入租户编码/ }),
      'ABC001',
    );
    await user.click(
      screen.getByRole('button', { name: '删除 10,142 条话单' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2026年8月 已删除 9,642 条');
    expect(alert).toHaveTextContent('尚未删除：2026年9月');
    expect(alert).toHaveTextContent(failureMessage);
    const retry = screen.getByRole('button', { name: '重试剩余月份' });
    await waitFor(() => expect(retry).toBeEnabled());
    await user.click(retry);
    expect(
      await screen.findByRole('heading', { name: '已删除 500 条话单' }),
    ).toBeVisible();
    expect(posts).toEqual([
      {
        fromMonth: '2026-08',
        toMonth: '2026-09',
        tenantCode: 'ABC001',
        expectedCount: 10142,
      },
      {
        fromMonth: '2026-09',
        toMonth: '2026-09',
        tenantCode: 'ABC001',
        expectedCount: 500,
      },
    ]);
  });
});
