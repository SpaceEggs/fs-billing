import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { beijingMinute } from '../../lib/rates';
import { RatesTab } from '../../pages/admin/tenant-tabs/rates-tab';

const self = {
  id: '00000000-0000-4000-8000-00000000a001',
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
} as AdminTenantDetailResponse;
const other = {
  id: '00000000-0000-4000-8000-00000000b003',
  code: 'BJH003',
  name: '北京华联信息技术有限公司',
};

const selfV1 = '00000000-0000-4000-8000-0000000000a1';
const selfV2 = '00000000-0000-4000-8000-0000000000a2';
const otherV1 = '00000000-0000-4000-8000-0000000000b1';
const otherV2 = '00000000-0000-4000-8000-0000000000b2';
const scheduledId = '00000000-0000-4000-8000-0000000000b9';
const previewId = '00000000-0000-4000-8000-0000000000cc';

const entries = [
  { iso: '', description: '', prefix: '86', country: '中国', rate: '0.045' },
  { iso: '', description: '', prefix: '44', country: '英国', rate: '0.05' },
];

type RatesReply = { id: string; entries: typeof entries; scheduled?: boolean };

function rates({ id, entries: rows, scheduled }: RatesReply) {
  return {
    currency: 'CNY',
    current: { id, effectiveFrom: '2026-10-01T00:00:00.000Z', entries: rows },
    scheduled: scheduled
      ? [
          {
            id: scheduledId,
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            entries: rows,
          },
        ]
      : [],
  };
}

function tenantSummary(tenant: { id: string; code: string; name: string }) {
  return {
    ...tenant,
    currency: 'CNY',
    status: 'active',
    health: 'normal',
    settingsConfigured: true,
    balance: '0',
    overdraftLimit: '0',
    availableBalance: '0',
    monthConsumption: '0',
    pendingReceivable: '0',
  };
}

const okPreview = {
  ok: true,
  previewId,
  expiresAt: '2026-10-16T14:00:00.000Z',
  currency: 'CNY',
  encoding: 'UTF-8',
  counts: { added: 1, modified: 0, deleted: 1 },
  changes: [
    {
      kind: 'added',
      after: {
        iso: '',
        description: '',
        prefix: '33',
        country: '法国',
        rate: '0.06',
      },
    },
    {
      kind: 'deleted',
      before: {
        iso: '',
        description: '',
        prefix: '64',
        country: '新西兰',
        rate: '0.2',
      },
    },
  ],
};

const committed = {
  auditId: '00000000-0000-4000-8000-0000000000dd',
  version: {
    id: '00000000-0000-4000-8000-0000000000ee',
    effectiveFrom: '2026-10-16T06:20:05.000Z',
    entries: [],
  },
};

const conflict = (code: string) => ({
  status: 409,
  body: { error: { code, message: code, requestId: 'req-test' } },
});

type Reply = { status: number; body?: unknown } | 'network';

/** `world` 给出各租户当前的费率表，测试中途可改；POST 由 `post` 应答；`ratesFailure` 返回非空时该次读取费率表失败。 */
function stubApi(
  world: Record<string, RatesReply>,
  post: (path: string, body: unknown) => Reply,
  ratesFailure: (tenantId: string) => Reply | null = () => null,
) {
  const posts: { path: string; body: unknown }[] = [];
  const gets: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit) => {
      if (init.method !== 'POST') {
        gets.push(path);
        const url = new URL(path, 'http://localhost');
        if (url.pathname === '/api/admin/tenants') {
          const items = [self, other].map(tenantSummary);
          return Promise.resolve(
            Response.json({
              items,
              pagination: { page: 1, pageSize: 20, total: items.length },
            }),
          );
        }
        const tenantId = url.pathname.split('/')[4]!;
        const failure = ratesFailure(tenantId);
        if (failure === 'network')
          return Promise.reject(new TypeError('offline'));
        if (failure)
          return Promise.resolve(
            Response.json(failure.body ?? null, { status: failure.status }),
          );
        return Promise.resolve(Response.json(rates(world[tenantId]!)));
      }
      const body: unknown = JSON.parse(init.body as string);
      posts.push({ path, body });
      const reply = post(path, body);
      if (reply === 'network') return Promise.reject(new TypeError('offline'));
      return Promise.resolve(
        Response.json(reply.body ?? null, { status: reply.status }),
      );
    }),
  );
  return { posts, gets };
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <RatesTab tenant={self} />
    </QueryClientProvider>,
  );
  return client;
}

const isPreview = (path: string) => path.endsWith('/rates/copy/preview');

async function openPush() {
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: '复制到其他租户' }),
  );
  const dialog = screen.getByRole('dialog', { name: '复制费率表到其他租户' });
  return { user, dialog };
}

async function pickOther(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
) {
  await user.click(
    await within(dialog).findByRole('radio', { name: /BJH003/ }),
  );
  await within(dialog).findByText(/已选：.*· \d+ 条/);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rate copy dialog', () => {
  it('push: lists only other same-currency tenants, warns about overwrite, and sends snapshotted ids even after a refetch', async () => {
    const world = {
      [self.id]: { id: selfV1, entries },
      [other.id]: { id: otherV1, entries: entries.slice(0, 1) },
    };
    const { posts, gets } = stubApi(world, (path) =>
      isPreview(path)
        ? { status: 200, body: okPreview }
        : { status: 200, body: committed },
    );
    const client = renderTab();
    const { user, dialog } = await openPush();

    expect(dialog).toHaveTextContent(
      '来源：ABC001 深圳市某某科技有限公司 · CNY · 2 条',
    );
    expect(dialog).toHaveTextContent('将覆盖目标租户的整张费率表');
    const group = await within(dialog).findByRole('radiogroup', {
      name: '目标租户',
    });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['BJH003北京华联信息技术有限公司']);
    expect(
      gets
        .filter((path) => path.startsWith('/api/admin/tenants?'))
        .map((path) =>
          Object.fromEntries(new URL(path, 'http://x').searchParams),
        ),
    ).toEqual([
      {
        currency: 'CNY',
        page: '1',
        pageSize: '20',
        sort: 'status_currency_balance',
      },
    ]);

    await pickOther(user, dialog);
    world[self.id] = { id: selfV2, entries };
    world[other.id] = { id: otherV2, entries };
    await client.refetchQueries();

    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览变动' }),
    );
    expect(
      await within(dialog).findByText('BJH003 的费率表将'),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      'BJH003 的费率表将新增 1 条、修改 0 条、删除 1 条，其余 0 条不变',
    );
    expect(dialog).toHaveTextContent(
      '将覆盖 BJH003 的整张费率表；删除后，拨打 64 新西兰 的呼叫将被拒绝',
    );
    expect(posts[0]).toEqual({
      path: `/api/admin/tenants/${self.id}/rates/copy/preview`,
      body: {
        sourceVersionId: selfV1,
        targetTenantId: other.id,
        targetBaseVersionId: otherV1,
        schedule: { kind: 'immediate' },
      },
    });

    await user.click(
      within(dialog).getByRole('button', { name: '确认覆盖 BJH003' }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '已复制到 BJH003新增 1 · 修改 0 · 删除 1生效时间 2026-10-16 14:20:05已记入操作日志',
    );
    expect(posts[1]).toEqual({
      path: `/api/admin/tenants/${self.id}/rates/copy/commit`,
      body: { previewId },
    });
  });

  it('pull: the empty table picks a source; path is the source and the target is this tenant', async () => {
    const world = {
      [self.id]: { id: selfV1, entries: [] },
      [other.id]: { id: otherV1, entries },
    };
    const { posts } = stubApi(world, () => ({ status: 200, body: okPreview }));
    const client = renderTab();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: '复制其他租户的费率表' }),
    );
    const dialog = screen.getByRole('dialog', { name: '复制其他租户的费率表' });
    expect(dialog).toHaveTextContent('将覆盖 ABC001 的整张费率表');
    await within(dialog).findByRole('radiogroup', { name: '来源租户' });
    await pickOther(user, dialog);
    world[other.id] = { id: otherV2, entries };
    world[self.id] = { id: selfV2, entries };
    await client.refetchQueries();

    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览变动' }),
    );
    await within(dialog).findByRole('button', { name: '确认覆盖 ABC001' });
    expect(posts[0]).toEqual({
      path: `/api/admin/tenants/${other.id}/rates/copy/preview`,
      body: {
        sourceVersionId: otherV1,
        targetTenantId: self.id,
        targetBaseVersionId: selfV1,
        schedule: { kind: 'immediate' },
      },
    });
  });

  it('blocks before preview when the target has a scheduled version', async () => {
    const { posts } = stubApi(
      {
        [self.id]: { id: selfV1, entries },
        [other.id]: { id: otherV1, entries, scheduled: true },
      },
      () => ({ status: 200, body: okPreview }),
    );
    renderTab();
    const { user, dialog } = await openPush();
    await pickOther(user, dialog);
    const next = within(dialog).getByRole('button', {
      name: '下一步：预览变动',
    });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription(
      '目标租户已有排定的新版本，请先在目标租户取消排定',
    );
    expect(posts).toEqual([]);
  });

  it('push stays available when only the source has a scheduled version', async () => {
    stubApi(
      {
        [self.id]: { id: selfV1, entries, scheduled: true },
        [other.id]: { id: otherV1, entries },
      },
      () => ({ status: 200, body: okPreview }),
    );
    renderTab();
    await screen.findByRole('region', { name: '排定的新版本' });
    const { user, dialog } = await openPush();
    await pickOther(user, dialog);
    expect(
      within(dialog).getByRole('button', { name: '下一步：预览变动' }),
    ).toBeEnabled();
  });

  it.each([
    [
      'preview',
      'RATE_VERSION_CONFLICT',
      '目标租户费率表已被修改，已载入最新版本',
    ],
    ['preview', 'CURRENCY_MISMATCH', '来源与目标租户币种不一致'],
    ['commit', 'PREVIEW_EXPIRED', '预览已过期，请重新预览'],
    ['commit', 'PREVIEW_STALE', '已载入最新版本，请重新预览'],
    ['commit', 'RATE_VERSION_CONFLICT', '已载入最新版本，请重新预览'],
    ['commit', 'CURRENCY_MISMATCH', '来源与目标租户币种不一致'],
  ])(
    '%s %s returns to step 1 keeping the tenant and schedule',
    async (stage, code, message) => {
      const world = {
        [self.id]: { id: selfV1, entries },
        [other.id]: { id: otherV1, entries },
      };
      const { posts } = stubApi(world, (path) => {
        if (stage === 'preview' || !isPreview(path)) {
          world[other.id] = { id: otherV2, entries };
          return conflict(code);
        }
        return { status: 200, body: okPreview };
      });
      renderTab();
      const { user, dialog } = await openPush();
      await pickOther(user, dialog);
      const minute = beijingMinute(Date.now() + 2 * 24 * 60 * 60 * 1000);
      await user.click(
        within(dialog).getByRole('radio', { name: '指定时间生效' }),
      );
      fireEvent.change(
        within(dialog).getByLabelText('指定生效时间（北京时间）'),
        { target: { value: minute } },
      );
      await user.click(
        within(dialog).getByRole('button', { name: '下一步：预览变动' }),
      );
      if (stage === 'commit')
        await user.click(
          await within(dialog).findByRole('button', {
            name: '确认覆盖 BJH003',
          }),
        );

      expect(await within(dialog).findByRole('status')).toHaveTextContent(
        message,
      );
      expect(
        within(dialog).getByRole('radio', { name: /BJH003/ }),
      ).toBeChecked();
      expect(
        within(dialog).getByLabelText('指定生效时间（北京时间）'),
      ).toHaveValue(minute);
      await user.click(
        within(dialog).getByRole('button', { name: '下一步：预览变动' }),
      );
      await waitFor(() =>
        expect(posts.filter((post) => isPreview(post.path)).length).toBe(2),
      );
      const rebased =
        code === 'RATE_VERSION_CONFLICT' || code === 'PREVIEW_STALE';
      expect(posts.at(-1)!.body).toMatchObject({
        sourceVersionId: selfV1,
        targetBaseVersionId: rebased ? otherV2 : otherV1,
        schedule: { kind: 'scheduled', effectiveFrom: `${minute}:00+08:00` },
      });
    },
  );

  it('a lost commit is never retried; a manual retry that gets PREVIEW_STALE refetches the target and asks to check', async () => {
    let commits = 0;
    const { gets } = stubApi(
      {
        [self.id]: { id: selfV1, entries },
        [other.id]: { id: otherV1, entries },
      },
      (path) => {
        if (isPreview(path)) return { status: 200, body: okPreview };
        commits += 1;
        return commits === 1 ? 'network' : conflict('PREVIEW_STALE');
      },
    );
    renderTab();
    const { user, dialog } = await openPush();
    await pickOther(user, dialog);
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览变动' }),
    );
    await user.click(
      await within(dialog).findByRole('button', { name: '确认覆盖 BJH003' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '无法确认是否已复制，请核对 BJH003 的费率表后再操作。',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commits).toBe(1);

    const targetReads = () =>
      gets.filter((path) =>
        path.startsWith(`/api/admin/tenants/${other.id}/rates`),
      ).length;
    const before = targetReads();
    await user.click(
      within(dialog).getByRole('button', { name: '确认覆盖 BJH003' }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '可能已复制，请核对 BJH003 的费率表',
    );
    expect(targetReads()).toBeGreaterThan(before);
    expect(commits).toBe(2);
  });
  it.each(['immediate', 'scheduled'] as const)(
    'pull %s: closing after success focuses the rates section once the opener is gone or disabled',
    async (kind) => {
      const minute = beijingMinute(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const world: Record<string, RatesReply> = {
        [self.id]: { id: selfV1, entries: [] },
        [other.id]: { id: otherV1, entries },
      };
      stubApi(world, (path) => {
        if (isPreview(path)) return { status: 200, body: okPreview };
        world[self.id] =
          kind === 'immediate'
            ? { id: selfV2, entries }
            : { id: selfV1, entries: [], scheduled: true };
        return { status: 200, body: committed };
      });
      renderTab();
      const user = userEvent.setup();
      const opener = await screen.findByRole('button', {
        name: '复制其他租户的费率表',
      });
      await user.click(opener);
      const dialog = screen.getByRole('dialog', {
        name: '复制其他租户的费率表',
      });
      await pickOther(user, dialog);
      if (kind === 'scheduled') {
        await user.click(
          within(dialog).getByRole('radio', { name: '指定时间生效' }),
        );
        fireEvent.change(
          within(dialog).getByLabelText('指定生效时间（北京时间）'),
          { target: { value: minute } },
        );
      }
      await user.click(
        within(dialog).getByRole('button', { name: '下一步：预览变动' }),
      );
      await user.click(
        await within(dialog).findByRole('button', { name: '确认覆盖 ABC001' }),
      );
      await within(dialog).findByText(/已复制到 ABC001/);
      if (kind === 'immediate')
        await waitFor(() => expect(opener).not.toBeInTheDocument());
      else await waitFor(() => expect(opener).toBeDisabled());

      await user.click(within(dialog).getByRole('button', { name: '完成' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: '费率表' })).toHaveFocus();
    },
  );

  it('a failed snapshot is retried in place, keeping the tenant and schedule', async () => {
    let otherReads = 0;
    const { posts, gets } = stubApi(
      {
        [self.id]: { id: selfV1, entries },
        [other.id]: { id: otherV1, entries: entries.slice(0, 1) },
      },
      () => ({ status: 200, body: okPreview }),
      (tenantId) => {
        if (tenantId !== other.id) return null;
        otherReads += 1;
        return otherReads === 1
          ? {
              status: 429,
              body: {
                error: {
                  code: 'RATE_LIMITED',
                  message: 'slow down',
                  requestId: 'req-test',
                  retryAfterSeconds: 5,
                },
              },
            }
          : null;
      },
    );
    renderTab();
    const { user, dialog } = await openPush();
    const minute = beijingMinute(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await user.click(
      within(dialog).getByRole('radio', { name: '指定时间生效' }),
    );
    fireEvent.change(
      within(dialog).getByLabelText('指定生效时间（北京时间）'),
      { target: { value: minute } },
    );
    await user.click(
      await within(dialog).findByRole('radio', { name: /BJH003/ }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '请在 5 秒后重试',
    );

    await user.click(
      within(dialog).getByRole('button', { name: '重新读取费率表' }),
    );
    await within(dialog).findByText(/已选：.*· 1 条/);
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(
      gets.filter((path) =>
        path.startsWith(`/api/admin/tenants/${other.id}/rates`),
      ),
    ).toHaveLength(2);
    expect(within(dialog).getByRole('radio', { name: /BJH003/ })).toBeChecked();
    expect(
      within(dialog).getByLabelText('指定生效时间（北京时间）'),
    ).toHaveValue(minute);

    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览变动' }),
    );
    await within(dialog).findByRole('button', { name: '确认覆盖 BJH003' });
    expect(posts[0]!.body).toEqual({
      sourceVersionId: selfV1,
      targetTenantId: other.id,
      targetBaseVersionId: otherV1,
      schedule: { kind: 'scheduled', effectiveFrom: `${minute}:00+08:00` },
    });
  });
});
