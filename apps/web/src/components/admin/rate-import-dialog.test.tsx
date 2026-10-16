import {
  act,
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

const tenant = {
  id: '00000000-0000-4000-8000-00000000a001',
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
} as AdminTenantDetailResponse;

const versionA = '00000000-0000-4000-8000-0000000000aa';
const versionB = '00000000-0000-4000-8000-0000000000bb';
const previewId = '00000000-0000-4000-8000-0000000000cc';

const entries = [
  { prefix: '86', country: '中国', rate: '0.045' },
  { prefix: '1876', country: '牙买加', rate: '0.3' },
  { prefix: '44', country: '英国', rate: '0.05' },
];

function rates(id: string, scheduled: unknown[] = []) {
  return {
    currency: 'CNY',
    current: { id, effectiveFrom: '2026-10-01T00:00:00.000Z', entries },
    scheduled,
  };
}

const okPreview = {
  ok: true,
  previewId,
  expiresAt: '2026-10-15T14:00:00.000Z',
  currency: 'CNY',
  encoding: 'GBK',
  counts: { added: 1, modified: 1, deleted: 1 },
  changes: [
    { kind: 'added', after: { prefix: '33', country: '法国', rate: '0.06' } },
    {
      kind: 'modified',
      before: { prefix: '86', country: '中国', rate: '0.045' },
      after: { prefix: '86', country: '中国', rate: '0.05' },
    },
    {
      kind: 'deleted',
      before: { prefix: '1876', country: '牙买加', rate: '0.3' },
    },
  ],
};

const conflict = (code: string) => ({
  status: 409,
  body: { error: { code, message: code, requestId: 'req-test' } },
});

type Reply = { status: number; body?: unknown } | 'network';

/** `post` 按路径结尾（preview / commit）应答，可返回待定的应答；GET 返回 `current()`。 */
function stubApi(
  post: (path: string, body: unknown) => Reply | Promise<Reply>,
  current: () => unknown = () => rates(versionA),
) {
  const posts: { path: string; body: unknown }[] = [];
  const gets: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit) => {
      if (init.method !== 'POST') {
        gets.push(path);
        return Promise.resolve(Response.json(current()));
      }
      const body: unknown = JSON.parse(init.body as string);
      posts.push({ path, body });
      return Promise.resolve(post(path, body)).then((reply) => {
        if (reply === 'network') throw new TypeError('offline');
        return Response.json(reply.body ?? null, { status: reply.status });
      });
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
      <RatesTab tenant={tenant} />
    </QueryClientProvider>,
  );
}

const csv = (text: string, name = '费率_修订版.csv') =>
  new File([new TextEncoder().encode(text)], name, { type: 'text/csv' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const drop = (target: Element, file: File) =>
  fireEvent.drop(target, { dataTransfer: { files: [file] } });

const scheduledVersion = {
  id: versionB,
  effectiveFrom: '2026-11-01T00:00:00.000Z',
  entries,
};

async function openAndUpload(
  file = csv('prefix,country,rate\n86,中国,0.05\n'),
) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: '导入 CSV' }));
  const dialog = screen.getByRole('dialog', { name: '导入费率表' });
  await user.upload(within(dialog).getByLabelText('选择 CSV 文件'), file);
  return { user, dialog };
}

const isPreview = (path: string) => path.endsWith('/rates/import/preview');

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rate import dialog', () => {
  it('keeps 下一步 disabled until a file is chosen and describes both schedule options', async () => {
    stubApi(() => ({ status: 200, body: okPreview }));
    renderTab();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '导入 CSV' }));
    const dialog = screen.getByRole('dialog', { name: '导入费率表' });
    const next = within(dialog).getByRole('button', { name: '下一步：预览' });
    expect(next).toBeDisabled();
    expect(
      within(dialog).getByRole('radio', { name: '立即生效' }),
    ).toHaveAccessibleDescription('确认导入后马上用于新呼叫');
    expect(
      within(dialog).getByRole('radio', { name: '指定时间生效' }),
    ).toHaveAccessibleDescription('到点前继续使用当前费率');

    await user.upload(
      within(dialog).getByLabelText('选择 CSV 文件'),
      csv('prefix,country,rate\n86,中国,0.05\n'),
    );
    expect(next).toBeEnabled();
  });

  it('lists every error line with its raw text and offers no way to continue', async () => {
    const { posts } = stubApi(() => ({
      status: 200,
      body: {
        ok: false,
        errors: [
          { line: 2, reason: '前缀只能是数字：8a6' },
          { line: 3, reason: '费率不能为负：-0.1' },
          { line: 5, reason: '费率最多 4 位小数：0.12345' },
          { line: 9, reason: '文件没有费率行' },
        ],
      },
    }));
    renderTab();
    const { user, dialog } = await openAndUpload(
      csv(
        '前缀,国家,费率\r\n8a6,中国,0.05\r\n44,英国,-0.1\r\n33,法国,0.06\r\n1,美国,0.12345\r\n',
      ),
    );
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '发现 4 处错误，文件未导入',
    );
    const rows = within(dialog)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(rows).toEqual([
      '第 2 行前缀只能是数字：8a68a6,中国,0.05',
      '第 3 行费率不能为负：-0.144,英国,-0.1',
      '第 5 行费率最多 4 位小数：0.123451,美国,0.12345',
      '第 9 行文件没有费率行—',
    ]);
    expect(
      within(dialog).queryByRole('button', { name: '确认导入' }),
    ).not.toBeInTheDocument();
    expect(posts.map((post) => post.path.split('/').at(-1))).toEqual([
      'preview',
    ]);
    await user.click(within(dialog).getByRole('button', { name: '重新上传' }));
    expect(within(dialog).getByText('费率_修订版.csv')).toBeInTheDocument();
  });

  it('previews counts, changes and the delete warning, then commits once and shows the result', async () => {
    const { posts } = stubApi((path) =>
      isPreview(path)
        ? { status: 200, body: okPreview }
        : {
            status: 200,
            body: {
              auditId: '00000000-0000-4000-8000-0000000000dd',
              version: {
                id: versionB,
                effectiveFrom: '2026-10-15T06:20:05.000Z',
                entries: [],
              },
            },
          },
    );
    renderTab();
    const { user, dialog } = await openAndUpload();
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );

    expect(await within(dialog).findByText('校验通过')).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      '校验通过将新增 1 条、修改 1 条、删除 1 条，其余 1 条不变',
    );
    expect(dialog).toHaveTextContent('费率_修订版.csv · GBK · 3 条');
    expect(dialog).toHaveTextContent(
      '删除后，拨打这些前缀的呼叫将被拒绝：1876 牙买加',
    );
    const rows = within(dialog)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent);
    expect(rows).toEqual([
      '新增33法国—0.0600',
      '修改86中国0.0450→0.0500+11.1%',
      '删除1876牙买加0.3000—',
    ]);
    expect(posts[0]!.body).toEqual({
      file: {
        filename: '费率_修订版.csv',
        contentBase64: btoa(
          String.fromCharCode(
            ...new TextEncoder().encode('prefix,country,rate\n86,中国,0.05\n'),
          ),
        ),
      },
      baseVersionId: versionA,
      schedule: { kind: 'immediate' },
    });

    await user.click(within(dialog).getByRole('button', { name: '确认导入' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '已导入，已生效新增 1 · 修改 1 · 删除 1生效时间 2026-10-15 14:20:05，新呼叫按新费率计费已记入操作日志',
    );
    expect(posts.slice(1)).toEqual([
      {
        path: `/api/admin/tenants/${tenant.id}/rates/import/commit`,
        body: { previewId },
      },
    ]);
  });

  it.each([
    ['PREVIEW_EXPIRED', '预览已过期，请重新预览'],
    ['PREVIEW_STALE', '已载入最新版本，请重新预览'],
    ['RATE_VERSION_CONFLICT', '已载入最新版本，请重新预览'],
  ])(
    'commit %s returns to step 1 keeping the file and schedule',
    async (code, message) => {
      let current = rates(versionA);
      const { posts } = stubApi(
        (path) => {
          if (isPreview(path)) return { status: 200, body: okPreview };
          current = rates(versionB);
          return conflict(code);
        },
        () => current,
      );
      renderTab();
      const { user, dialog } = await openAndUpload();
      const minute = beijingMinute(Date.now() + 2 * 24 * 60 * 60 * 1000);
      await user.click(
        within(dialog).getByRole('radio', { name: '指定时间生效' }),
      );
      fireEvent.change(
        within(dialog).getByLabelText('指定生效时间（北京时间）'),
        {
          target: { value: minute },
        },
      );
      await user.click(
        within(dialog).getByRole('button', { name: '下一步：预览' }),
      );
      await user.click(
        await within(dialog).findByRole('button', { name: '确认导入' }),
      );

      expect(await within(dialog).findByRole('status')).toHaveTextContent(
        message,
      );
      expect(within(dialog).getByText('费率_修订版.csv')).toBeInTheDocument();
      expect(
        within(dialog).getByRole('radio', { name: '指定时间生效' }),
      ).toBeChecked();
      expect(
        within(dialog).getByLabelText('指定生效时间（北京时间）'),
      ).toHaveValue(minute);

      await user.click(
        within(dialog).getByRole('button', { name: '下一步：预览' }),
      );
      await waitFor(() => expect(posts).toHaveLength(3));
      expect(posts[2]!.body).toMatchObject({
        baseVersionId: code === 'PREVIEW_EXPIRED' ? versionA : versionB,
        schedule: { kind: 'scheduled', effectiveFrom: `${minute}:00+08:00` },
      });
    },
  );

  it('a preview RATE_VERSION_CONFLICT reloads the base and stays on step 1', async () => {
    stubApi(() => conflict('RATE_VERSION_CONFLICT'));
    renderTab();
    const { user, dialog } = await openAndUpload();
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '费率表已被修改，已载入最新版本，请重新预览',
    );
    expect(within(dialog).getByText('费率_修订版.csv')).toBeInTheDocument();
  });

  it('a lost commit response is never retried automatically; a manual retry that gets PREVIEW_STALE refetches and asks to check', async () => {
    let commits = 0;
    const { posts, gets } = stubApi((path) => {
      if (isPreview(path)) return { status: 200, body: okPreview };
      commits += 1;
      return commits === 1 ? 'network' : conflict('PREVIEW_STALE');
    });
    renderTab();
    const { user, dialog } = await openAndUpload();
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );
    await user.click(
      await within(dialog).findByRole('button', { name: '确认导入' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '无法确认是否已导入，请核对费率表后再操作。',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(commits).toBe(1);

    const getsBefore = gets.length;
    await user.click(within(dialog).getByRole('button', { name: '确认导入' }));
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '可能已导入，请核对费率表',
    );
    expect(gets.length).toBeGreaterThan(getsBefore);
    expect(commits).toBe(2);
    expect(posts).toHaveLength(3);
  });

  it('ignores a file dropped while a preview is pending and shows the preview under the file that was sent', async () => {
    const reply = deferred<Reply>();
    const { posts } = stubApi(() => reply.promise);
    renderTab();
    const { user, dialog } = await openAndUpload(csv('a', 'A.csv'));
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );
    expect(
      within(dialog).getByRole('button', { name: '正在预览…' }),
    ).toBeDisabled();
    drop(
      within(dialog).getByText('A.csv').closest('label')!,
      csv('b', 'B.csv'),
    );
    expect(within(dialog).getByText('A.csv')).toBeInTheDocument();
    expect(within(dialog).queryByText('B.csv')).not.toBeInTheDocument();

    reply.resolve({ status: 200, body: okPreview });
    expect(
      await within(dialog).findByRole('button', { name: '确认导入' }),
    ).toBeEnabled();
    expect(dialog).toHaveTextContent('A.csv · GBK · 3 条');
    expect(dialog).not.toHaveTextContent('B.csv');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ file: { filename: 'A.csv' } });
  });

  it('drops a preview response that a newer file selection made obsolete', async () => {
    const reply = deferred<Reply>();
    const { posts } = stubApi(() => reply.promise);
    renderTab();
    const { dialog } = await openAndUpload(csv('a', 'A.csv'));
    const next = within(dialog).getByRole('button', { name: '下一步：预览' });
    const zone = within(dialog).getByText('A.csv').closest('label')!;
    // 同一批事件里先预览再换文件：换文件时界面还没进入「正在预览」，靠请求编号丢弃 A 的应答。
    act(() => {
      fireEvent.click(next);
      drop(zone, csv('b', 'B.csv'));
    });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ file: { filename: 'A.csv' } });

    await act(async () => {
      reply.resolve({ status: 200, body: okPreview });
      await reply.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      within(dialog).queryByRole('button', { name: '确认导入' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText('B.csv')).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    ).toBeEnabled();
  });

  it('returns focus to the rates section when a scheduled import disables the import button', async () => {
    let current = rates(versionA);
    stubApi(
      (path) => {
        if (isPreview(path)) return { status: 200, body: okPreview };
        current = rates(versionA, [scheduledVersion]);
        return {
          status: 200,
          body: {
            auditId: '00000000-0000-4000-8000-0000000000dd',
            version: scheduledVersion,
          },
        };
      },
      () => current,
    );
    renderTab();
    const { user, dialog } = await openAndUpload();
    await user.click(
      within(dialog).getByRole('radio', { name: '指定时间生效' }),
    );
    fireEvent.change(
      within(dialog).getByLabelText('指定生效时间（北京时间）'),
      {
        target: { value: beijingMinute(Date.now() + 2 * 24 * 60 * 60 * 1000) },
      },
    );
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    );
    await user.click(
      await within(dialog).findByRole('button', { name: '确认导入' }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '已导入，已排定新版本',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '导入 CSV', hidden: true }),
      ).toBeDisabled(),
    );

    await user.click(
      within(dialog).getByRole('button', { name: '返回费率表' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '费率表' })).toHaveFocus();
  });

  it('disables import while a scheduled version exists', async () => {
    stubApi(
      () => ({ status: 500 }),
      () =>
        rates(versionA, [
          {
            id: versionB,
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            entries,
          },
        ]),
    );
    renderTab();
    await screen.findByRole('region', { name: '排定的新版本' });
    const button = screen.getByRole('button', { name: '导入 CSV' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      '已有排定的新版本，请先取消排定',
    );
  });

  it('lists scheduled changes inline, marks the affected rows and disables single edits (G4)', async () => {
    stubApi(
      () => ({ status: 500 }),
      () =>
        rates(versionA, [
          {
            id: versionB,
            // 北京时间 2026-11-01 08:00。
            effectiveFrom: '2026-11-01T00:00:00.000Z',
            entries: [
              { prefix: '86', country: '中国', rate: '0.048' },
              { prefix: '44', country: '英国', rate: '0.05' },
            ],
          },
        ]),
    );
    renderTab();
    const card = await screen.findByRole('region', { name: '排定的新版本' });
    expect(
      within(card)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '变动前缀国家/备注当前费率（元/分钟）新费率（元/分钟）涨跌',
      '修改86中国0.0450→0.0480+6.7%',
      '删除1876牙买加0.3000—',
    ]);

    const table = screen.getByRole('region', { name: '费率表' });
    const rowText = (prefix: string) =>
      within(table)
        .getAllByRole('row')
        .find((row) => row.textContent?.startsWith(prefix))?.textContent;
    expect(rowText('86')).toBe('86中国0.045011-01 起 0.0480编辑');
    expect(rowText('1876')).toBe('1876牙买加0.300011-01 起删除编辑');
    expect(rowText('44')).toBe('44英国0.0500编辑');
    for (const name of ['编辑 86 中国', '编辑 44 英国']) {
      const edit = screen.getByRole('button', { name });
      expect(edit).toBeDisabled();
      expect(edit).toHaveAccessibleDescription(
        '已有排定的新版本，请先取消排定',
      );
    }
  });

  it('rejects a file over 2 MiB before reading or uploading it', async () => {
    const { posts } = stubApi(() => ({ status: 200, body: okPreview }));
    renderTab();
    const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.csv', {
      type: 'text/csv',
    });
    const { dialog } = await openAndUpload(big);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      '文件超过 2 MB 上限',
    );
    expect(
      within(dialog).getByRole('button', { name: '下一步：预览' }),
    ).toBeDisabled();
    expect(posts).toEqual([]);
  });

  it('downloads the template as UTF-8 with BOM, header and one example row', async () => {
    stubApi(() => ({ status: 500 }));
    let blob: Blob | undefined;
    vi.stubGlobal('URL', {
      createObjectURL: (value: Blob) => {
        blob = value;
        return 'blob:template';
      },
      revokeObjectURL: () => {},
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe('费率模板.csv');
      });
    renderTab();
    const { user, dialog } = await openAndUpload();
    await user.click(
      within(dialog).getByRole('button', { name: '下载 CSV 模板' }),
    );
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('前缀,国家,费率\r\n1,美国,0.0500\r\n'),
    ]);
    expect(blob!.type).toBe('text/csv;charset=utf-8');
  });
});
