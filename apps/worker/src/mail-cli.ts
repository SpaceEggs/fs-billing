import type { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  connect,
  databaseEnvironmentSchema,
  requeueFailedEmails,
  withSystem,
} from '@fs-billing/db';
import { renderMail } from '@fs-billing/shared';
import {
  isLoopbackHost,
  mailEnvironmentSchema,
  mailSettingsOf,
  type MailSettings,
} from './config.js';
import {
  MAIL_FROM_NAME,
  classifySmtpError,
  createMailTransport,
  testMessageId,
  type MailTransport,
} from './mail.js';

export interface MailCliIo {
  stdout: Writable;
  stderr: Writable;
}

const write = (stream: Writable, data: string) =>
  new Promise<void>((resolve, reject) => {
    stream.write(data, (error) => (error ? reject(error) : resolve()));
  });

/** pnpm 会把 `--` 原样传给脚本；parseArgs 把它当成“之后全是位置参数”，所以先去掉开头的一个。 */
const normalizeArgs = (argv: readonly string[]) =>
  argv[0] === '--' ? argv.slice(1) : [...argv];

/** 配置错误只报键名与固定文字，不回显取值（SMTP_PASS 是授权码）。 */
const configIssues = (error: z.ZodError) =>
  error.issues
    .map((issue) => `${issue.path.join('.') || '配置'}：${issue.message}`)
    .join('；');

export interface MailTestDeps {
  /** 测试注入；默认按 SMTP 配置建一个不使用连接池的 SMTP 传输。 */
  createTransport?: (settings: MailSettings) => MailTransport;
  now?: () => Date;
}

/**
 * `mail:test --to <地址>[,<地址>…]`：用 SMTP_* 环境变量直接发一封测试邮件，核实 SMTP 配置
 * （上线前对真实账号做的手工核实，见 docs/evidence/phase-9/）。不经过发件箱、不写数据库、不碰告警。
 * 输出服务器响应码与首行；失败时给出分类（可重试 / 认证 / 永久）。退出码 0 成功，1 失败。
 */
export async function runMailTest(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: MailCliIo,
  deps: MailTestDeps = {},
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: normalizeArgs(argv),
      options: { to: { type: 'string', multiple: true } },
      strict: true,
    }));
  } catch (error) {
    await write(
      io.stderr,
      `参数错误：${error instanceof Error ? error.message : '无法解析'}\n用法：mail:test --to <地址>[,<地址>…]\n`,
    );
    return 1;
  }
  const recipients = z
    .array(z.email())
    .min(1)
    .max(5)
    .safeParse(
      (values.to ?? [])
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  if (!recipients.success) {
    await write(io.stderr, '参数错误：--to 需要 1 到 5 个有效的邮箱地址\n');
    return 1;
  }
  const parsed = mailEnvironmentSchema.safeParse(env);
  if (!parsed.success) {
    await write(io.stderr, `配置错误：${configIssues(parsed.error)}\n`);
    return 1;
  }
  const settings = mailSettingsOf(parsed.data);
  if (!settings) {
    await write(io.stderr, '配置错误：SMTP_HOST 未设置，邮件发送未启用\n');
    return 1;
  }
  const clock = deps.now ?? (() => new Date());
  const transport = (
    deps.createTransport ?? ((s) => createMailTransport(s, { pool: false }))
  )(settings);
  const rendered = renderMail('test', { sentAt: clock().toISOString() });
  const started = Date.now();
  try {
    const result = await transport.send({
      messageId: testMessageId(),
      from: { name: MAIL_FROM_NAME, address: settings.from },
      to: recipients.data,
      ...rendered,
    });
    await write(
      io.stdout,
      `发送成功：${settings.host}:${settings.port}（${settings.secure ? '隐式 TLS' : isLoopbackHost(settings.host) ? '回环地址，允许明文' : 'STARTTLS'}），` +
        `接受 ${result.accepted.length} 个收件人，拒绝 ${result.rejected.length} 个，` +
        `用时 ${Date.now() - started} ms\n服务器响应：${result.response.split(/\r?\n/)[0] ?? ''}\n`,
    );
    return result.accepted.length > 0 ? 0 : 1;
  } catch (error) {
    const failure = classifySmtpError(error);
    const label = {
      retry: '可重试（连接、超时、4xx、限流）',
      auth: '认证失败（检查 SMTP_USER / SMTP_PASS，QQ 邮箱要用授权码）',
      permanent: '永久失败（收件人或整封被拒）',
    }[failure.class];
    await write(
      io.stderr,
      `发送失败：${label}\n${failure.summary}\n用时 ${Date.now() - started} ms\n`,
    );
    return 1;
  } finally {
    transport.close();
  }
}

/** `--since` 接受带时区的时间，或 YYYY-MM-DD（按北京时间当天 0 点）。 */
const sinceSchema = z.union([
  z.iso.datetime({ offset: true }),
  z.iso.date().transform((day) => `${day}T00:00:00+08:00`),
]);

const requeueEnvironment = z.object({
  APP_DATABASE_URL: databaseEnvironmentSchema.shape.APP_DATABASE_URL,
});

/**
 * `mail:requeue --id <uuid>` 或 `--since <时间>`：把 failed 的邮件放回 pending，尝试次数清零
 * （用于 QQ 每日额度恢复后补发）。只改 failed 的行；退出码 0 成功（含放回 0 封），1 参数或配置错误。
 */
export async function runMailRequeue(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  io: MailCliIo,
  now: () => Date = () => new Date(),
): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: normalizeArgs(argv),
      options: { id: { type: 'string' }, since: { type: 'string' } },
      strict: true,
    }));
  } catch (error) {
    await write(
      io.stderr,
      `参数错误：${error instanceof Error ? error.message : '无法解析'}\n`,
    );
    return 1;
  }
  if ((values.id === undefined) === (values.since === undefined)) {
    await write(
      io.stderr,
      '用法：mail:requeue --id <uuid> 或 mail:requeue --since <时间>（二选一）\n',
    );
    return 1;
  }
  let target: { id: string } | { since: Date };
  if (values.id !== undefined) {
    const id = z.uuid().safeParse(values.id);
    if (!id.success) {
      await write(io.stderr, '参数错误：--id 不是有效的 UUID\n');
      return 1;
    }
    target = { id: id.data };
  } else {
    const since = sinceSchema.safeParse(values.since);
    if (!since.success) {
      await write(
        io.stderr,
        '参数错误：--since 需要带时区的时间（2026-10-29T08:00:00+08:00）或日期（2026-10-29，按北京时间）\n',
      );
      return 1;
    }
    target = { since: new Date(since.data) };
  }
  const parsed = requeueEnvironment.safeParse(env);
  if (!parsed.success) {
    await write(io.stderr, '配置错误：需要 APP_DATABASE_URL\n');
    return 1;
  }
  const connection = connect(parsed.data.APP_DATABASE_URL, { max: 2 });
  try {
    const count = await withSystem(connection.db, (tx) =>
      requeueFailedEmails(tx, target, now()),
    );
    await write(
      io.stdout,
      count > 0
        ? `已放回 ${count} 封邮件，将在下一分钟的 notify-tick 发送\n`
        : '没有符合条件的 failed 邮件\n',
    );
    return 0;
  } finally {
    await connection.pool.end();
  }
}
