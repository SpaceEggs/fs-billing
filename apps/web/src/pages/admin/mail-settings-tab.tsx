import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminMailSettingsResponse,
  Identity,
  MailTestResult,
  ValidationIssue,
} from '@fs-billing/shared';
import { apiKey, apiQuery } from '../../lib/admin-api';
import { callApi, type ApiBody } from '../../lib/api';
import {
  apiProblem,
  fieldIssues,
  problemNotice,
  type ApiProblem,
} from '../../lib/api-problem';
import { formatDateTime } from '../../lib/format';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Switch } from '../../components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';

type MailConfig = Omit<
  ApiBody<'adminMailSettingsUpdate'>,
  'expectedVersion' | 'password'
>;

type SaveMessage =
  { kind: 'saved'; text: string } | { kind: 'conflict'; text: string } | null;

const sourceLabels = {
  page: '页面',
  env: '环境变量',
  none: '无',
} as const;

const testResultLabels: Record<MailTestResult, string> = {
  ok: '成功',
  auth: '认证失败',
  retry: '连接失败或超时',
  permanent: '被拒收',
};

const testResultMessages: Record<
  MailTestResult,
  { title: string; body: string; variant: 'success' | 'warning' | 'error' }
> = {
  ok: {
    title: '测试邮件已发送',
    body: '服务器已接受，请到收件人邮箱查收。这只说明服务器接受了，请确认真的收到了再保存。',
    variant: 'success',
  },
  auth: {
    title: '测试邮件发送失败：认证错误',
    body: '账号或授权码不对。配置没有保存，也没有改变。',
    variant: 'error',
  },
  retry: {
    title: '测试邮件发送失败：连接失败或超时',
    body: '请检查服务器、端口、加密方式和服务器的出站网络。',
    variant: 'warning',
  },
  permanent: {
    title: '测试邮件发送失败：被拒收',
    body: '请检查发件人和收件人。',
    variant: 'error',
  },
};

function isQqHost(host: string | null | undefined) {
  const value = (host ?? '').trim().toLowerCase();
  return value === 'qq.com' || value.endsWith('.qq.com');
}

function normalizeHost(host: string | null | undefined) {
  return (host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

function isLoopbackHost(host: string) {
  const value = normalizeHost(host);
  return value === 'localhost' || value === '127.0.0.1' || value === '::1';
}

function deliveryStatus(settings: AdminMailSettingsResponse) {
  if (settings.source === 'none')
    return { label: '未配置', variant: 'muted' as const };
  if (!settings.passwordUsable)
    return { label: '需要处理', variant: 'warning' as const };
  if (settings.source === 'page' && !settings.enabled)
    return { label: '已停用', variant: 'off' as const };
  if (settings.delivery.lastAttemptFailed)
    return { label: '发送失败', variant: 'error' as const };
  return { label: '正常', variant: 'ok' as const };
}

export function MailSettingsTab({ identity }: { identity: Identity }) {
  const client = useQueryClient();
  const [message, setMessage] = useState<SaveMessage>(null);
  const query = useQuery(apiQuery('adminMailSettings'));
  if (query.isError) {
    const notice = problemNotice(apiProblem(query.error));
    return (
      <Alert variant="error" role="alert">
        <AlertDescription>
          <strong>{notice.title}</strong>
          {notice.body ? <p>{notice.body}</p> : null}
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!query.data) return <p>加载中…</p>;
  return (
    <MailSettingsForm
      key={query.data.version}
      settings={query.data}
      identity={identity}
      message={message}
      setMessage={setMessage}
      reload={async () => {
        await client.invalidateQueries({
          queryKey: apiKey('adminMailSettings'),
        });
      }}
    />
  );
}

function MailSettingsForm({
  settings,
  identity,
  message,
  setMessage,
  reload,
}: {
  settings: AdminMailSettingsResponse;
  identity: Identity;
  message: SaveMessage;
  setMessage: (message: SaveMessage) => void;
  reload: () => Promise<void>;
}) {
  const id = useId();
  const envSource = settings.source === 'env';
  const initialHost = envSource ? settings.env.host : settings.host;
  const initialPort = envSource ? settings.env.port : settings.port;
  const initialSecure = envSource ? settings.env.secure : settings.secure;
  const initialUsername = envSource ? settings.env.username : settings.username;
  const initialMailFrom = envSource ? settings.env.mailFrom : settings.mailFrom;
  const initialSiteUrl = envSource ? settings.env.siteUrl : settings.siteUrl;

  const [editingEnv, setEditingEnv] = useState(false);
  const editing = !envSource || editingEnv;
  const [enabled, setEnabled] = useState(envSource ? true : settings.enabled);
  const [host, setHost] = useState(initialHost ?? '');
  const [port, setPort] = useState(
    initialPort === null ? '' : String(initialPort),
  );
  const [secure, setSecure] = useState(initialSecure ?? false);
  const [username, setUsername] = useState(initialUsername ?? '');
  const [mailFrom, setMailFrom] = useState(initialMailFrom ?? '');
  const [siteUrl, setSiteUrl] = useState(initialSiteUrl ?? '');
  const [provider, setProvider] = useState<'qq' | 'custom'>(() =>
    isQqHost(initialHost) ? 'qq' : 'custom',
  );
  const [showPassword, setShowPassword] = useState(
    !settings.passwordSet || !settings.passwordUsable,
  );
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const [testResult, setTestResult] = useState<{
    result: MailTestResult;
    to: string;
  } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [testTo, setTestTo] = useState(identity.email);

  const hostChanged = normalizeHost(host) !== normalizeHost(initialHost ?? '');
  const usernameChanged = username !== (initialUsername ?? '');
  const passwordChanged =
    settings.passwordSet && (hostChanged || usernameChanged);
  const passwordRequired =
    !(isLoopbackHost(host) && username.trim() === '') &&
    (!settings.passwordSet || !settings.passwordUsable || passwordChanged);
  const showPasswordInput =
    !settings.passwordSet ||
    !settings.passwordUsable ||
    showPassword ||
    passwordChanged;

  const issues = fieldIssues(problem);
  const notice = problem ? problemNotice(problem) : null;
  const status = deliveryStatus(settings);
  const testMessage = testResult ? testResultMessages[testResult.result] : null;

  const save = useMutation({
    mutationFn: (body: ApiBody<'adminMailSettingsUpdate'>) =>
      callApi('adminMailSettingsUpdate', { body }),
  });
  const test = useMutation({
    mutationFn: (body: ApiBody<'adminMailSettingsTest'>) =>
      callApi('adminMailSettingsTest', { body }),
  });

  function config(): MailConfig {
    return {
      enabled,
      host: host.trim() === '' ? null : host.trim(),
      port: port.trim() === '' ? null : Number(port),
      secure,
      username: username.trim() === '' ? null : username.trim(),
      mailFrom:
        provider === 'qq'
          ? username.trim() === ''
            ? null
            : username.trim()
          : mailFrom.trim() === ''
            ? null
            : mailFrom.trim(),
      siteUrl: siteUrl.trim() === '' ? null : siteUrl.trim(),
    };
  }

  function fieldError(field: string) {
    return issues.get(field);
  }

  function describedBy(field: string, helpId?: string) {
    return fieldError(field) ? `${id}-${field}-error` : helpId;
  }

  function selectProvider(value: string) {
    if (value !== 'qq' && value !== 'custom') return;
    setProvider(value);
    if (value === 'qq') {
      setHost('smtp.qq.com');
      setPort('465');
      setSecure(true);
      setMailFrom(username);
    }
  }

  function changeHost(value: string) {
    setHost(value);
    if (isQqHost(value)) setProvider('qq');
    else if (provider === 'qq') setProvider('custom');
  }

  function changeUsername(value: string) {
    setUsername(value);
    if (provider === 'qq') setMailFrom(value);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setProblem(null);
    setTestResult(null);
    if (passwordRequired && password.trim() === '') {
      const issues: ValidationIssue[] = [
        { path: ['password'], message: '请填写密码或授权码' },
      ];
      setProblem({ kind: 'validation', issues });
      return;
    }
    const body: ApiBody<'adminMailSettingsUpdate'> = {
      ...config(),
      expectedVersion: settings.version,
      ...(password === '' ? {} : { password }),
    };
    try {
      const result = await save.mutateAsync(body);
      setMessage({
        kind: 'saved',
        text: result.auditId === null ? '设置未更改' : '设置已保存',
      });
      setPassword('');
      setShowPassword(false);
      await reload();
    } catch (error) {
      const problem = apiProblem(error);
      if (
        problem.kind === 'conflict' &&
        problem.code === 'MAIL_SETTINGS_VERSION_CONFLICT'
      ) {
        setMessage({
          kind: 'conflict',
          text: '邮箱设置已被其他人修改，已重新加载当前设置，您未保存的输入已被替换。',
        });
        await reload();
      } else {
        setProblem(problem);
      }
    }
  }

  async function sendTest() {
    setProblem(null);
    setTestResult(null);
    const body: ApiBody<'adminMailSettingsTest'> = {
      ...config(),
      to: testTo.trim(),
    };
    try {
      const result = await test.mutateAsync(body);
      setDialogOpen(false);
      setTestResult({ result: result.result, to: testTo.trim() });
      await reload();
    } catch (error) {
      setDialogOpen(false);
      setProblem(apiProblem(error));
    }
  }

  const configAlert =
    settings.source === 'none' ? (
      <Alert variant="warning">
        <AlertDescription>
          <strong>邮件发送未配置</strong>
          <p>告警和余额提醒都发不出去。填写后先发一封测试邮件，再保存。</p>
        </AlertDescription>
      </Alert>
    ) : settings.source === 'env' ? (
      <Alert variant="warning">
        <AlertDescription>
          <strong>当前使用服务器环境变量里的配置</strong>
          <p>
            邮件在正常发送。这里显示的是读到的内容。点“改由页面管理”后，以后就在这里修改。
          </p>
        </AlertDescription>
      </Alert>
    ) : !settings.keyConfigured ? (
      <Alert variant="error">
        <AlertDescription>
          服务器还没有配置 SETTINGS_ENCRYPTION_KEY，不能保存密码。请联系运维。
        </AlertDescription>
      </Alert>
    ) : settings.passwordSet && !settings.passwordUsable ? (
      <Alert variant="error">
        <AlertDescription>
          已保存的密码无法解密，请重新填写。邮件暂时不会发出。
        </AlertDescription>
      </Alert>
    ) : null;

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
      <Card
        asChild
        className="block w-full max-w-[620px] gap-0 overflow-hidden rounded-xl border bg-card py-0 text-inherit shadow-none"
      >
        <form onSubmit={(event) => void submit(event)}>
          <div className="space-y-5 p-5 md:p-6">
            {configAlert}
            {message ? (
              <Alert
                variant={message.kind === 'conflict' ? 'warning' : 'success'}
                role={message.kind === 'conflict' ? 'alert' : undefined}
              >
                <AlertDescription>{message.text}</AlertDescription>
              </Alert>
            ) : null}
            {notice ? (
              <Alert
                variant={problem?.kind === 'validation' ? 'error' : 'warning'}
                role="alert"
              >
                <AlertDescription>
                  <strong>{notice.title}</strong>
                  {notice.body ? <p>{notice.body}</p> : null}
                  {notice.details?.length ? (
                    <ul className="mt-2 list-disc pl-5">
                      {notice.details.map((detail) => (
                        <li key={detail}>{detail}</li>
                      ))}
                    </ul>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : null}
            {testMessage ? (
              <Alert variant={testMessage.variant} role="alert">
                <AlertDescription>
                  <strong>{testMessage.title}</strong>
                  <p>
                    {testResult?.result === 'ok' && testResult.to
                      ? `服务器已接受，请到 ${testResult.to} 查收。这只说明服务器接受了，请确认真的收到了再保存。`
                      : testMessage.body}
                  </p>
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor={`${id}-enabled`}>启用邮件发送</Label>
                <p
                  id={`${id}-enabled-help`}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  关闭后，告警和提醒继续排队，但不会发出
                </p>
              </div>
              <Switch
                id={`${id}-enabled`}
                checked={enabled}
                disabled={!editing}
                aria-describedby={`${id}-enabled-help`}
                onCheckedChange={setEnabled}
              />
            </div>

            <div className="space-y-2">
              <Label>服务商</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-label="服务商"
                value={provider}
                disabled={!editing}
                onValueChange={selectProvider}
              >
                <ToggleGroupItem value="qq">QQ 邮箱</ToggleGroupItem>
                <ToggleGroupItem value="custom">自定义</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor={`${id}-host`}>SMTP 服务器</Label>
                  <span className="text-err" aria-hidden="true">
                    *
                  </span>
                </div>
                <Input
                  id={`${id}-host`}
                  value={host}
                  readOnly={!editing}
                  placeholder="smtp.example.com"
                  aria-invalid={fieldError('host') ? true : undefined}
                  aria-describedby={describedBy('host')}
                  onChange={(event) => changeHost(event.target.value)}
                />
                {fieldError('host') ? (
                  <p
                    id={`${id}-host-error`}
                    className="text-xs text-err"
                    role="alert"
                  >
                    {fieldError('host')}
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor={`${id}-port`}>端口</Label>
                  <span className="text-err" aria-hidden="true">
                    *
                  </span>
                </div>
                <Input
                  id={`${id}-port`}
                  value={port}
                  readOnly={!editing}
                  inputMode="numeric"
                  placeholder="465"
                  aria-invalid={fieldError('port') ? true : undefined}
                  aria-describedby={describedBy('port')}
                  onChange={(event) => setPort(event.target.value)}
                />
                {fieldError('port') ? (
                  <p
                    id={`${id}-port-error`}
                    className="text-xs text-err"
                    role="alert"
                  >
                    {fieldError('port')}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${id}-username`}>账号</Label>
              <Input
                id={`${id}-username`}
                value={username}
                readOnly={!editing}
                placeholder="billing@example.com"
                aria-invalid={fieldError('username') ? true : undefined}
                aria-describedby={describedBy('username')}
                onChange={(event) => changeUsername(event.target.value)}
              />
              {fieldError('username') ? (
                <p
                  id={`${id}-username-error`}
                  className="text-xs text-err"
                  role="alert"
                >
                  {fieldError('username')}
                </p>
              ) : null}
            </div>

            {envSource && !editing ? null : (
              <div className="space-y-2">
                <div className="flex items-center gap-1">
                  <Label htmlFor={`${id}-password`}>
                    {provider === 'qq' ? '授权码' : '密码或授权码'}
                  </Label>
                  {passwordRequired ? (
                    <span className="text-err" aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </div>
                {settings.passwordSet && !showPasswordInput ? (
                  <div className="flex items-center gap-3">
                    <span className="text-sm">已设置</span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!editing}
                      onClick={() => setShowPassword(true)}
                    >
                      更改
                    </Button>
                  </div>
                ) : (
                  <Input
                    id={`${id}-password`}
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    readOnly={!editing}
                    required={passwordRequired}
                    aria-required={passwordRequired}
                    aria-invalid={fieldError('password') ? true : undefined}
                    aria-describedby={describedBy(
                      'password',
                      `${id}-password-help`,
                    )}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
                {fieldError('password') ? (
                  <p
                    id={`${id}-password-error`}
                    className="text-xs text-err"
                    role="alert"
                  >
                    {fieldError('password')}
                  </p>
                ) : null}
                <p
                  id={`${id}-password-help`}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
                  不是 QQ 登录密码。保存后加密存储，不再显示。
                </p>
                {passwordChanged && settings.passwordSet ? (
                  <p className="text-xs text-warn">
                    服务器或账号改过了，请重新填写密码或授权码。
                  </p>
                ) : null}
              </div>
            )}

            <div className="space-y-2">
              <div className="flex items-center gap-1">
                <Label htmlFor={`${id}-mail-from`}>发件人邮箱</Label>
                <span className="text-err" aria-hidden="true">
                  *
                </span>
              </div>
              <Input
                id={`${id}-mail-from`}
                value={provider === 'qq' ? username : mailFrom}
                readOnly={!editing || provider === 'qq'}
                placeholder="billing@example.com"
                aria-invalid={fieldError('mailFrom') ? true : undefined}
                aria-describedby={describedBy(
                  'mailFrom',
                  provider === 'qq' ? `${id}-mail-from-help` : undefined,
                )}
                onChange={(event) => setMailFrom(event.target.value)}
              />
              {fieldError('mailFrom') ? (
                <p
                  id={`${id}-mailFrom-error`}
                  className="text-xs text-err"
                  role="alert"
                >
                  {fieldError('mailFrom')}
                </p>
              ) : null}
              {provider === 'qq' ? (
                <p
                  id={`${id}-mail-from-help`}
                  className="text-xs text-muted-foreground"
                >
                  QQ 邮箱要求和账号相同
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${id}-site-url`}>站点地址</Label>
              <Input
                id={`${id}-site-url`}
                value={siteUrl}
                readOnly={!editing}
                placeholder="https://billing.example.com"
                aria-invalid={fieldError('siteUrl') ? true : undefined}
                aria-describedby={describedBy('siteUrl', `${id}-site-url-help`)}
                onChange={(event) => setSiteUrl(event.target.value)}
              />
              {fieldError('siteUrl') ? (
                <p
                  id={`${id}-siteUrl-error`}
                  className="text-xs text-err"
                  role="alert"
                >
                  {fieldError('siteUrl')}
                </p>
              ) : null}
              <p
                id={`${id}-site-url-help`}
                className="text-xs text-muted-foreground"
              >
                邮件里的链接指向这个地址
              </p>
            </div>

            <div className="space-y-2">
              <Label>加密方式</Label>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-label="加密方式"
                aria-invalid={fieldError('secure') ? true : undefined}
                aria-describedby={
                  fieldError('secure') ? `${id}-secure-error` : undefined
                }
                value={secure ? 'tls' : 'starttls'}
                disabled={!editing}
                onValueChange={(value) => {
                  if (value === 'tls') setSecure(true);
                  if (value === 'starttls') setSecure(false);
                }}
              >
                <ToggleGroupItem value="tls">隐式 TLS</ToggleGroupItem>
                <ToggleGroupItem value="starttls">STARTTLS</ToggleGroupItem>
              </ToggleGroup>
              {fieldError('secure') ? (
                <p
                  id={`${id}-secure-error`}
                  className="text-xs text-err"
                  role="alert"
                >
                  {fieldError('secure')}
                </p>
              ) : null}
              {settings.allowPlaintext ? (
                <p className="text-xs text-muted-foreground">
                  STARTTLS：回环地址（如本机 Mailpit）可以不加密
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t px-5 py-3">
            <span className="text-xs whitespace-nowrap text-muted-foreground">
              修改记入操作日志，密码不会记录
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!editing || test.isPending}
                onClick={() => setDialogOpen(true)}
              >
                发送测试邮件
              </Button>
              {envSource && !editingEnv ? (
                <Button onClick={() => setEditingEnv(true)}>
                  改由页面管理
                </Button>
              ) : (
                <Button type="submit" disabled={save.isPending}>
                  保存
                </Button>
              )}
            </div>
          </div>
        </form>
      </Card>

      <Card className="w-full gap-0 py-0 lg:max-w-[320px]">
        <CardHeader className="flex flex-row items-center justify-between gap-3 px-5 pt-5 pb-3">
          <CardTitle className="text-base">发送状态</CardTitle>
          <Badge variant={status.variant}>{status.label}</Badge>
        </CardHeader>
        <CardContent className="space-y-3 px-5 pb-5 text-sm">
          <dl className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">配置来源</dt>
              <dd>{sourceLabels[settings.source]}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">最近成功发送</dt>
              <dd>
                {settings.delivery.lastSentAt
                  ? formatDateTime(settings.delivery.lastSentAt)
                  : '暂无'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">最近测试</dt>
              <dd className="text-right">
                {settings.lastTestAt
                  ? `${formatDateTime(settings.lastTestAt)} · ${
                      settings.lastTestResult
                        ? testResultLabels[settings.lastTestResult]
                        : '已测试'
                    }`
                  : '暂无'}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">等待发送</dt>
              <dd>{settings.delivery.pendingCount} 封</dd>
            </div>
          </dl>
          <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
            这里的配置用于告警和余额提醒等所有系统邮件。服务器监测脚本有单独的配置，数据库宕机时仍能发信，由运维维护。
          </p>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>发送测试邮件</DialogTitle>
            <DialogDescription>
              用表单里当前填写的配置发送，即使还没保存。发送不会改变已保存的配置。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${id}-test-to`}>收件人</Label>
            <Input
              id={`${id}-test-to`}
              type="email"
              value={testTo}
              onChange={(event) => setTestTo(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={test.isPending}
              onClick={() => setDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              disabled={test.isPending || testTo.trim() === ''}
              onClick={() => void sendTest()}
            >
              {test.isPending ? '发送中…' : '发送'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
