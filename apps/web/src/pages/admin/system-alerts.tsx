import { Fragment, useState, useSyncExternalStore } from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  alertKindLabel,
  alertKindSchema,
  adminAlertSettingsUpdateRequestSchema,
  type Identity,
  type AdminAlertSettingsResponse,
  type AdminSystemAlert,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { RecipientsInput } from '../../components/admin/form-fields';
import { SheetPanel } from '../../components/sheet-panel';
import { Segmented } from '../../components/segmented';
import { LoadError } from '../../components/load-error';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../components/ui/native-select';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui/tabs';
import { apiKey, apiQuery } from '../../lib/admin-api';
import { ApiRequestError, callApi } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';

const tableQuery = '(min-width: 1100px)';
function useTableLayout() {
  return useSyncExternalStore(
    (notify) => {
      const media = window.matchMedia?.(tableQuery);
      media?.addEventListener('change', notify);
      return () => media?.removeEventListener('change', notify);
    },
    () => window.matchMedia?.(tableQuery).matches ?? true,
    () => true,
  );
}
function AlertStatus({ status }: { status: AdminSystemAlert['status'] }) {
  return (
    <Badge variant={status === 'open' ? 'error' : 'off'}>
      <span className="size-1.5 rounded-full bg-current" />
      {status === 'open' ? '进行中' : '已恢复'}
    </Badge>
  );
}
function Detail({
  alert,
  onClose,
}: {
  alert: AdminSystemAlert;
  onClose: () => void;
}) {
  const query = useQuery(
    apiQuery('adminSystemAlertDetail', { params: { alertId: alert.id } }),
  );
  const d = query.data;
  if (query.isError)
    return (
      <LoadError
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  if (!d) return <p className="p-4">加载中…</p>;
  const tenant = d.tenant ?? d.affectedTenants?.items[0];
  const digestCount = d.notices.filter(
    (n) => n.template === 'alert_digest' && n.status === 'sent',
  ).length;
  const callCount = d.unassignedFilter ? (
    <Link
      className="font-semibold text-primary"
      to="/admin/unassigned"
      search={{
        reason: d.unassignedFilter.reason,
        tag: d.unassignedFilter.tag ?? undefined,
      }}
    >
      {d.affectedCalls} 通
    </Link>
  ) : tenant && d.cdrRange ? (
    <Link
      className="font-semibold text-primary"
      to="/admin/tenants/$tenantId"
      params={{ tenantId: tenant.id }}
      search={{
        tab: 'cdrs',
        unverifiedOnly: d.kind === 'auth_timeout' ? true : undefined,
        cdrFrom: d.cdrRange.fromDay,
        cdrTo: d.cdrRange.toDay,
      }}
    >
      {d.affectedCalls} 通
    </Link>
  ) : (
    <strong>{d.affectedCalls} 通</strong>
  );
  const rows: { label: string; value: React.ReactNode }[] = [
    {
      label: '开始时间',
      value: (
        <>
          {formatDateTime(d.startedAt)}
          {d.kind === 'auth_timeout' ? '（按话单到达时间记录）' : ''}
        </>
      ),
    },
    {
      label: '恢复时间',
      value: d.recoveredAt ? formatDateTime(d.recoveredAt) : '进行中',
    },
    {
      label: '持续时长',
      value: `${Math.floor(d.durationSeconds / 60)} 分 ${d.durationSeconds % 60} 秒`,
    },
    { label: '影响的通话', value: callCount },
    ...(d.cdrRange
      ? [
          {
            label: '话单范围',
            value: `${formatDateTime(d.cdrRange.from)} – ${formatDateTime(d.cdrRange.to)}`,
          },
        ]
      : []),
    ...(d.affectedTenants?.items.length
      ? [
          {
            label: '受影响租户',
            value: (
              <>
                {d.affectedTenants.truncated ? <p>仅统计最近 30 天</p> : null}
                {d.affectedTenants.items.map((t) => (
                  <div key={t.id}>
                    <Link
                      className="text-primary"
                      to="/admin/tenants/$tenantId"
                      params={{ tenantId: t.id }}
                      search={{
                        tab: 'cdrs',
                        unverifiedOnly: true,
                        cdrFrom: d.cdrRange?.fromDay,
                        cdrTo: d.cdrRange?.toDay,
                      }}
                    >
                      {t.code} · {t.name} · {t.count} 通
                    </Link>
                  </div>
                ))}
              </>
            ),
          },
        ]
      : []),
    { label: '说明', value: d.description },
    {
      label: '通知记录',
      value: d.notices.length
        ? d.notices.map((n, i) => (
            <p key={`${n.queuedAt}-${i}`}>
              {formatDateTime(n.queuedAt)} ·{' '}
              {
                {
                  alert_start: '告警开始',
                  alert_digest: '告警汇总',
                  alert_recovered: '告警恢复',
                }[n.template]
              }{' '}
              ·{' '}
              {
                {
                  pending: '待发送',
                  sending: '发送中',
                  sent: '已发送',
                  failed: '发送失败',
                  skipped: '已跳过',
                }[n.status]
              }
              {n.skipReason ? ` · ${n.skipReason}` : ''}
            </p>
          ))
        : '暂无通知记录',
    },
  ];
  return (
    <div className="bg-card text-sm">
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <strong className="text-base">{d.kindLabel}</strong>
            <AlertStatus status={d.status} />
          </div>
          <p className="mt-1 text-muted-foreground">{d.description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="关闭详情"
          onClick={onClose}
        >
          ×
        </Button>
      </div>
      <dl className="grid grid-cols-[100px_minmax(0,1fr)] px-4 sm:grid-cols-[120px_minmax(0,1fr)]">
        {rows.map((row) => (
          <Fragment key={row.label}>
            <dt className="border-b py-3 text-muted-foreground">{row.label}</dt>
            <dd className="m-0 min-w-0 border-b py-3 break-words">
              {row.value}
            </dd>
          </Fragment>
        ))}
      </dl>
      <div className="flex items-center justify-between gap-3 p-4">
        <span className="text-xs text-muted-foreground">
          已发送 {digestCount} 封汇总邮件
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
          {d.unassignedFilter ? (
            <Button asChild>
              <Link
                to="/admin/unassigned"
                search={{
                  reason: d.unassignedFilter.reason,
                  tag: d.unassignedFilter.tag ?? undefined,
                }}
              >
                查看这 {d.affectedCalls} 通话单 ›
              </Link>
            </Button>
          ) : tenant && d.cdrRange ? (
            <Button asChild>
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId: tenant.id }}
                search={{
                  tab: 'cdrs',
                  unverifiedOnly: d.kind === 'auth_timeout' ? true : undefined,
                  cdrFrom: d.cdrRange.fromDay,
                  cdrTo: d.cdrRange.toDay,
                }}
              >
                查看这 {d.affectedCalls} 通话单 ›
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
function AlertRow({
  alert,
  selected,
  onToggle,
}: {
  alert: AdminSystemAlert;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <Fragment>
      <tr
        className={cn(
          'cursor-pointer border-t hover:bg-muted',
          alert.status === 'open' && 'bg-err-soft',
        )}
        onClick={onToggle}
      >
        <td className="p-3 whitespace-nowrap">
          <button aria-expanded={selected}>
            {formatDateTime(alert.startedAt)}
          </button>
        </td>
        <td className="p-3 font-medium whitespace-nowrap">{alert.kindLabel}</td>
        <td className="w-full p-3">{alert.description}</td>
        <td className="p-3 whitespace-nowrap">
          <AlertStatus status={alert.status} />
        </td>
        <td className="pr-4 text-muted-foreground">›</td>
      </tr>
      {selected ? (
        <tr>
          <td colSpan={5}>
            <Detail alert={alert} onClose={onToggle} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
type SettingsMessage =
  | { kind: 'conflict'; recipients: string[]; minutes: number }
  | { kind: 'notice'; text: string }
  | null;
function Settings() {
  const client = useQueryClient();
  const [message, setMessage] = useState<SettingsMessage>(null);
  const query = useQuery(apiQuery('adminAlertSettings'));
  if (query.isError)
    return (
      <LoadError
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
      />
    );
  if (!query.data) return <p>加载中…</p>;
  return (
    <SettingsForm
      key={query.data.version}
      settings={query.data}
      message={message}
      setMessage={setMessage}
      reload={async () => {
        await client.invalidateQueries({
          queryKey: apiKey('adminAlertSettings'),
        });
      }}
    />
  );
}
function SettingsForm({
  settings,
  reload,
  message,
  setMessage,
}: {
  settings: AdminAlertSettingsResponse;
  reload: () => Promise<void>;
  message: SettingsMessage;
  setMessage: (message: SettingsMessage) => void;
}) {
  const [recipients, setRecipients] = useState(settings.recipients);
  const [minutes, setMinutes] = useState(String(settings.digestMinutes));
  const [error, setError] = useState<string>();
  const save = useMutation({
    mutationFn: (body: {
      recipients: string[];
      digestMinutes: number;
      expectedVersion: number;
    }) => callApi('adminAlertSettingsUpdate', { body }),
  });
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = adminAlertSettingsUpdateRequestSchema.safeParse({
      recipients,
      digestMinutes: Number(minutes),
      expectedVersion: settings.version,
    });
    if (!parsed.success) {
      setError('请输入有效邮箱（最多 20 个）和 1–1440 分钟的整数');
      return;
    }
    setError(undefined);
    try {
      const result = await save.mutateAsync(parsed.data);
      setMessage({
        kind: 'notice',
        text: result.auditId === null ? '设置未更改' : '设置已保存',
      });
      if (result.auditId !== null) await reload();
    } catch (err) {
      if (
        err instanceof ApiRequestError &&
        err.code === 'ALERT_SETTINGS_VERSION_CONFLICT'
      ) {
        setMessage({
          kind: 'conflict',
          recipients: parsed.data.recipients,
          minutes: parsed.data.digestMinutes,
        });
        await reload();
      } else setMessage({ kind: 'notice', text: '保存失败，请刷新后重试' });
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-[620px] overflow-hidden rounded-xl border bg-card"
    >
      <div className="space-y-5 p-5 md:p-6">
        {!settings.mailEnabled ? (
          <Alert variant="warning">
            <AlertDescription>
              邮件发送未配置，告警和提醒不会发出
            </AlertDescription>
          </Alert>
        ) : null}
        {message?.kind === 'conflict' ? (
          <Alert variant="warning" role="alert">
            <AlertDescription>
              告警设置已被其他人修改，已重新加载当前设置，您未保存的输入已被替换。您提交的邮箱：
              {message.recipients.join('、') || '（空）'}；汇总间隔：
              {message.minutes} 分钟。
            </AlertDescription>
          </Alert>
        ) : message ? (
          <Alert>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}
        <RecipientsInput
          stacked
          label="告警接收邮箱"
          helper="可添加多个，告警邮件会发送到这些邮箱"
          emptyNote="未设置接收邮箱，当前发给全部管理员"
          emails={recipients}
          error={error}
          onChange={setRecipients}
        />
        <div className="space-y-2">
          <label htmlFor="digest-minutes" className="text-sm font-medium">
            汇总邮件间隔
          </label>
          <Segmented
            className="w-fit"
            label="常用汇总间隔"
            options={['5', '15', '30', '60'].map((value) => ({
              value,
              label: `${value} 分钟`,
            }))}
            value={minutes}
            onChange={setMinutes}
          />
          <div className="flex items-center gap-2 text-sm">
            <label htmlFor="digest-minutes">自定义（分钟）</label>
            <input
              id="digest-minutes"
              className="w-24 rounded-md border bg-background p-2"
              type="number"
              min="1"
              max="1440"
              step="1"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            间隔内的告警合并为一封汇总邮件，避免短时间内收到大量邮件。默认 15
            分钟。
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 border-t px-5 py-3">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          修改记入操作日志
        </span>
        <Button type="submit" disabled={save.isPending}>
          保存
        </Button>
      </div>
    </form>
  );
}
export function SystemAlertsPage({ identity }: { identity: Identity }) {
  const [status, setStatus] = useState<'all' | 'open' | 'recovered'>('all');
  const [kind, setKind] = useState('');
  const initialSearch = useSearch({ from: '/admin/system-alerts' });
  const tab = initialSearch.tab === 'settings' ? 'settings' : 'list';
  const navigate = useNavigate({ from: '/admin/system-alerts' });
  const [window, setWindow] = useState<'24h' | '30d' | 'all'>(
    initialSearch.window ?? '30d',
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminSystemAlert | null>(null);
  const desktop = useTableLayout();
  const parsedKind = alertKindSchema.safeParse(kind);
  const query = useQuery({
    ...apiQuery('adminSystemAlerts', {
      query: {
        status,
        window,
        page,
        ...(parsedKind.success ? { kind: parsedKind.data } : {}),
      },
    }),
    enabled: tab === 'list',
  });
  const filtered = status !== 'all' || kind !== '' || window !== '30d';
  function clearFilters() {
    setStatus('all');
    setKind('');
    setWindow('30d');
    void navigate({ search: {}, replace: true });
    setPage(1);
  }
  return (
    <AppShell
      identity={identity}
      title="系统告警"
      crumb="系统告警"
      activeNav="系统告警"
      mobileActions={
        <Button
          variant="outline"
          size="icon"
          aria-label={tab === 'list' ? '告警设置' : '返回告警列表'}
          onClick={() =>
            void navigate({
              search: {
                ...initialSearch,
                tab: tab === 'list' ? 'settings' : undefined,
              },
            })
          }
        >
          {tab === 'list' ? <SettingsIcon /> : '‹'}
        </Button>
      }
    >
      <PageBody
        title="系统告警"
        meta={query.data ? `进行中 ${query.data.openCount}` : undefined}
      >
        <Tabs
          value={tab}
          onValueChange={(value) =>
            void navigate({
              search: {
                ...initialSearch,
                tab: value === 'settings' ? 'settings' : undefined,
              },
            })
          }
          className="gap-5"
        >
          <TabsList className="max-md:hidden">
            <TabsTrigger value="list">告警列表</TabsTrigger>
            <TabsTrigger value="settings">设置</TabsTrigger>
          </TabsList>
          <TabsContent value="settings">
            <Settings />
          </TabsContent>
          <TabsContent value="list" className="flex flex-col gap-5">
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                label="状态"
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'open', label: '进行中' },
                  { value: 'recovered', label: '已恢复' },
                ]}
                value={status}
                onChange={(value) => {
                  setStatus(value);
                  setPage(1);
                }}
              />
              <NativeSelect
                aria-label="类型"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setPage(1);
                }}
              >
                <NativeSelectOption value="">全部类型</NativeSelectOption>
                {alertKindSchema.options.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {alertKindLabel(k)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <NativeSelect
                aria-label="时间"
                value={window}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === '24h' || v === '30d' || v === 'all') {
                    setWindow(v);
                    void navigate({
                      search: v === '24h' ? { window: '24h' } : {},
                      replace: true,
                    });
                  }
                  setPage(1);
                }}
              >
                <NativeSelectOption value="24h">
                  最近 24 小时
                </NativeSelectOption>
                <NativeSelectOption value="30d">最近 30 天</NativeSelectOption>
                <NativeSelectOption value="all">全部时间</NativeSelectOption>
              </NativeSelect>
            </div>
            {query.isError ? (
              <LoadError
                error={query.error}
                retrying={query.isFetching}
                onRetry={() => void query.refetch()}
              />
            ) : !query.data ? (
              <p>加载中…</p>
            ) : query.data.items.length === 0 ? (
              <div className="rounded-xl border p-12 text-center">
                <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-xl text-ok">
                  ✓
                </div>
                <p className="font-semibold">
                  {filtered
                    ? '没有符合筛选条件的系统告警'
                    : '最近 30 天没有系统告警'}
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  {filtered
                    ? '请调整筛选条件后重试'
                    : '计费授权、话单处理和邮件发送均正常'}
                </p>
                {filtered ? (
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={clearFilters}
                  >
                    清除筛选
                  </Button>
                ) : null}
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground max-md:hidden">
                  共 {query.data.pagination.total} 条
                </p>
                {desktop ? (
                  <div className="overflow-hidden rounded-xl border">
                    <table
                      className="w-full text-left text-sm"
                      aria-label="系统告警"
                    >
                      <thead className="bg-muted text-muted-foreground">
                        <tr>
                          {['时间', '类型', '说明', '状态', ''].map(
                            (label, i) => (
                              <th
                                key={i}
                                className="p-3 font-medium whitespace-nowrap"
                              >
                                {label}
                              </th>
                            ),
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {query.data.items.map((a) => (
                          <AlertRow
                            key={a.id}
                            alert={a}
                            selected={selected?.id === a.id}
                            onToggle={() =>
                              setSelected(selected?.id === a.id ? null : a)
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {query.data.items.map((a) => (
                      <button
                        key={a.id}
                        className={cn(
                          'w-full rounded-xl border bg-card p-4 text-left',
                          a.status === 'open' &&
                            'border-err-border bg-err-soft',
                        )}
                        onClick={() => setSelected(a)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <strong>{a.kindLabel}</strong>
                          <AlertStatus status={a.status} />
                        </div>
                        <p className="mt-2 text-sm">{a.description}</p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          {formatDateTime(a.startedAt)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    disabled={page <= 1}
                    onClick={() => setPage(page - 1)}
                  >
                    上一页
                  </Button>
                  <span>第 {page} 页</span>
                  <Button
                    variant="outline"
                    disabled={
                      page * query.data.pagination.pageSize >=
                      query.data.pagination.total
                    }
                    onClick={() => setPage(page + 1)}
                  >
                    下一页
                  </Button>
                </div>
              </>
            )}
            {!desktop && selected ? (
              <SheetPanel
                side="bottom"
                title="告警详情"
                open
                onOpenChange={(open) => {
                  if (!open) setSelected(null);
                }}
              >
                <div className="max-h-[75vh] overflow-auto">
                  <Detail alert={selected} onClose={() => setSelected(null)} />
                </div>
              </SheetPanel>
            ) : null}
          </TabsContent>
        </Tabs>
      </PageBody>
    </AppShell>
  );
}
