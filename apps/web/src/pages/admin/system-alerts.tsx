import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import {
  alertKindLabel,
  alertKindSchema,
  adminAlertSettingsUpdateRequestSchema,
  type Identity,
  type AdminAlertSettingsResponse,
  type AdminSystemAlert,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { SheetPanel } from '../../components/sheet-panel';
import { LoadError } from '../../components/load-error';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { apiKey, apiQuery } from '../../lib/admin-api';
import { ApiRequestError, callApi } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { useIsDesktop } from '../../lib/use-is-desktop';

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
      <tr className="cursor-pointer border-t hover:bg-muted" onClick={onToggle}>
        <td className="p-3">
          <button className="text-primary" aria-expanded={selected}>
            {formatDateTime(alert.startedAt)}
          </button>
        </td>
        <td className="p-3">{alert.kindLabel}</td>
        <td className="p-3">{alert.description}</td>
        <td
          className={
            alert.status === 'open'
              ? 'p-3 text-destructive'
              : 'p-3 text-muted-foreground'
          }
        >
          {alert.status === 'open' ? '进行中' : '已恢复'}
        </td>
      </tr>
      {selected ? (
        <tr>
          <td colSpan={4}>
            <Detail alert={alert} />
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function Detail({ alert }: { alert: AdminSystemAlert }) {
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
  if (!d) return <p>加载中…</p>;
  return (
    <div className="space-y-3 p-4 text-sm">
      <p>{d.description}</p>
      <p>
        开始时间：{formatDateTime(d.startedAt)}
        {d.kind === 'auth_timeout' ? '（按话单到达时间记录）' : ''}
      </p>
      <p>
        恢复时间：{d.recoveredAt ? formatDateTime(d.recoveredAt) : '进行中'}
      </p>
      <p>
        持续时长：{Math.floor(d.durationSeconds / 60)} 分{' '}
        {d.durationSeconds % 60} 秒
      </p>
      <p>影响的通话：{d.affectedCalls} 通</p>
      {d.cdrRange ? (
        <p>
          话单范围：{formatDateTime(d.cdrRange.from)} –{' '}
          {formatDateTime(d.cdrRange.to)}
        </p>
      ) : null}
      {d.affectedTenants ? (
        <div>
          <p>
            受影响租户
            {d.affectedTenants.truncated ? '（仅统计最近 30 天）' : ''}
          </p>
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
        </div>
      ) : null}
      {d.unassignedFilter ? (
        <Link
          className="text-primary"
          to="/admin/unassigned"
          search={{
            reason: d.unassignedFilter.reason,
            tag: d.unassignedFilter.tag ?? undefined,
          }}
        >
          查看未归属话单
        </Link>
      ) : null}
      <div>
        <h3 className="font-semibold">通知记录</h3>
        {d.notices.length ? (
          d.notices.map((n, i) => (
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
        ) : (
          <p>暂无通知记录</p>
        )}
      </div>
    </div>
  );
}

function Settings() {
  const client = useQueryClient();
  const [message, setMessage] = useState('');
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
  message: string;
  setMessage: (message: string) => void;
}) {
  const [recipients, setRecipients] = useState(settings.recipients.join('\n'));
  const [minutes, setMinutes] = useState(String(settings.digestMinutes));
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
      recipients: recipients.split(/[\s,;，；]+/).filter(Boolean),
      digestMinutes: Number(minutes),
      expectedVersion: settings.version,
    });
    if (!parsed.success) {
      setMessage('请输入有效邮箱（最多 20 个）和 1–1440 分钟的整数');
      return;
    }
    try {
      const result = await save.mutateAsync(parsed.data);
      setMessage(result.auditId === null ? '设置未更改' : '设置已保存');
      if (result.auditId !== null) await reload();
    } catch (error) {
      if (
        error instanceof ApiRequestError &&
        error.code === 'ALERT_SETTINGS_VERSION_CONFLICT'
      ) {
        await reload();
        setMessage('告警设置已被其他人修改，已重新加载当前设置');
      } else setMessage('保存失败，请刷新后重试');
    }
  }
  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="max-w-xl space-y-4 rounded-xl border bg-card p-5"
    >
      {!settings.mailEnabled ? (
        <Alert variant="warning">
          <AlertDescription>
            邮件发送未配置，告警和提醒不会发出
          </AlertDescription>
        </Alert>
      ) : null}
      <label className="block text-sm font-medium">
        告警接收邮箱
        <textarea
          className="mt-2 block min-h-24 w-full rounded-md border bg-background p-2 font-normal"
          value={recipients}
          onChange={(e) => setRecipients(e.target.value)}
          placeholder="每行一个邮箱，最多 20 个"
        />
      </label>
      {!recipients.trim() ? (
        <p className="text-sm text-muted-foreground">
          未设置接收邮箱，当前发给全部管理员
        </p>
      ) : null}
      <label className="block text-sm font-medium">
        汇总邮件间隔（分钟）
        <input
          className="mt-2 block w-32 rounded-md border bg-background p-2"
          type="number"
          min="1"
          max="1440"
          step="1"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2" aria-label="常用汇总间隔">
        {[5, 15, 30, 60].map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={minutes === String(value)}
            className="rounded-md border px-3 py-1 text-sm aria-pressed:bg-muted"
            onClick={() => setMinutes(String(value))}
          >
            {value} 分钟
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        间隔内的告警合并为一封汇总邮件，默认 15 分钟。修改记入操作日志。
      </p>
      {message ? (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={save.isPending}>
        保存
      </Button>
    </form>
  );
}

export function SystemAlertsPage({ identity }: { identity: Identity }) {
  const [tab, setTab] = useState<'list' | 'settings'>('list');
  const [status, setStatus] = useState<'all' | 'open' | 'recovered'>('all');
  const [kind, setKind] = useState('');
  const initialSearch = useSearch({ from: '/admin/system-alerts' });
  const [window, setWindow] = useState<'24h' | '30d' | 'all'>(
    initialSearch.window ?? '30d',
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminSystemAlert | null>(null);
  const desktop = useIsDesktop();
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
  return (
    <AppShell
      identity={identity}
      title="系统告警"
      crumb="系统告警"
      activeNav="系统告警"
    >
      <PageBody
        title="系统告警"
        meta={query.data ? `进行中 ${query.data.openCount}` : undefined}
      >
        <div role="tablist" className="flex gap-5 border-b">
          {(
            [
              ['list', '告警列表'],
              ['settings', '设置'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className="border-b-2 border-transparent px-1 py-3 aria-selected:border-primary"
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'settings' ? (
          <Settings />
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <label>
                状态{' '}
                <select
                  value={status}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === 'all' || v === 'open' || v === 'recovered')
                      setStatus(v);
                    setPage(1);
                  }}
                  className="rounded border bg-background p-2"
                >
                  <option value="all">全部状态</option>
                  <option value="open">进行中</option>
                  <option value="recovered">已恢复</option>
                </select>
              </label>
              <label>
                类型{' '}
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value);
                    setPage(1);
                  }}
                  className="rounded border bg-background p-2"
                >
                  <option value="">全部类型</option>
                  {alertKindSchema.options.map((k) => (
                    <option key={k} value={k}>
                      {alertKindLabel(k)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                时间{' '}
                <select
                  value={window}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '24h' || v === '30d' || v === 'all') setWindow(v);
                    setPage(1);
                  }}
                  className="rounded border bg-background p-2"
                >
                  <option value="24h">最近 24 小时</option>
                  <option value="30d">最近 30 天</option>
                  <option value="all">全部时间</option>
                </select>
              </label>
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
                没有系统告警
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  共 {query.data.pagination.total} 条
                </p>
                {desktop ? (
                  <div className="overflow-hidden rounded-xl border">
                    <table
                      className="w-full text-left text-sm"
                      aria-label="系统告警"
                    >
                      <thead className="bg-muted">
                        <tr>
                          {['时间', '类型', '说明', '状态'].map((label) => (
                            <th key={label} className="p-3 font-medium">
                              {label}
                            </th>
                          ))}
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
                        className="w-full rounded-xl border bg-card p-4 text-left"
                        onClick={() => setSelected(a)}
                      >
                        <div className="flex justify-between">
                          <strong>{a.kindLabel}</strong>
                          <span
                            className={
                              a.status === 'open'
                                ? 'text-destructive'
                                : 'text-muted-foreground'
                            }
                          >
                            {a.status === 'open' ? '进行中' : '已恢复'}
                          </span>
                        </div>
                        <p>{a.description}</p>
                        <p className="text-sm text-muted-foreground">
                          {formatDateTime(a.startedAt)}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
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
                  <h2 className="font-semibold">{selected.kindLabel}</h2>
                  <Detail alert={selected} />
                </div>
              </SheetPanel>
            ) : null}
          </>
        )}
      </PageBody>
    </AppShell>
  );
}
