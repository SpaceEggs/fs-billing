import { createServer, type Server, type Socket } from 'node:net';
import type { MailSettings } from '../src/config.js';

/**
 * 邮件测试的公用部分（只被 *.test.ts 引用）。
 *
 * Mailpit 的地址故意不读 SMTP_*：开发机的 .env 里可能是真实邮箱的配置，测试绝不能连上去。
 * 只认 MAILPIT_* 环境变量，默认值就是 compose.yaml 的端口，并且必须是回环地址。
 */
export const MAILPIT_SMTP_HOST = process.env.MAILPIT_SMTP_HOST ?? '127.0.0.1';
export const MAILPIT_SMTP_PORT = Number(process.env.MAILPIT_SMTP_PORT ?? 1025);
export const MAILPIT_API_URL =
  process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025';

for (const host of [MAILPIT_SMTP_HOST, new URL(MAILPIT_API_URL).hostname]) {
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host))
    throw new Error(`邮件测试只允许连接回环地址上的 Mailpit，当前是 ${host}`);
}

/** 指向 Mailpit 的邮件配置；`overrides` 用来改超时、尝试次数等。 */
export function mailpitSettings(
  overrides: Partial<MailSettings> = {},
): MailSettings {
  return {
    host: MAILPIT_SMTP_HOST,
    port: MAILPIT_SMTP_PORT,
    secure: false,
    user: undefined,
    pass: undefined,
    from: 'billing@example.test',
    timeoutMs: 5000,
    ratePerTick: 20,
    maxAttempts: 6,
    siteUrl: undefined,
    ...overrides,
  };
}

export interface MailpitMessage {
  ID: string;
  MessageID: string;
  Subject: string;
  From: { Name: string; Address: string };
  To: { Name: string; Address: string }[];
  Created: string;
}
export interface MailpitDetail extends MailpitMessage {
  Text: string;
  HTML: string;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${MAILPIT_API_URL}${path}`, init);
  } catch (error) {
    throw new Error(
      `邮件测试需要 Mailpit（${MAILPIT_API_URL}）：先执行 pnpm db:up（compose.yaml 里的 mailpit 服务）`,
      { cause: error },
    );
  }
  if (!response.ok) throw new Error(`Mailpit ${path} 返回 ${response.status}`);
  // DELETE 返回纯文本 ok，其余是 JSON。
  const text = await response.text();
  return (text.startsWith('{') ? JSON.parse(text) : text) as T;
}

export async function clearMailpit(): Promise<void> {
  await api('/api/v1/messages', { method: 'DELETE' });
}

/** 最新的在前。 */
export async function mailpitMessages(): Promise<MailpitMessage[]> {
  return (
    await api<{ messages: MailpitMessage[] }>('/api/v1/messages?limit=500')
  ).messages;
}

export function mailpitMessage(id: string): Promise<MailpitDetail> {
  return api<MailpitDetail>(`/api/v1/message/${id}`);
}

// ---------------------------------------------------------------------------
// 假 SMTP 服务：在指定阶段返回指定的响应，用来检验失败分类（nodemailer 产生的真实错误对象）。
// ---------------------------------------------------------------------------

export interface FakeSmtpScript {
  /** 连接问候；默认 `220 fake ESMTP`。 */
  greeting?: string;
  /** 为 true 时不发问候，用来触发问候超时。 */
  silent?: boolean;
  /** 对 AUTH 的响应；默认 `235 2.7.0 ok`。EHLO 总是声明支持 AUTH PLAIN。 */
  auth?: string;
  mailFrom?: string;
  /** 逐个收件人的 RCPT TO 响应（参数是小写地址）；默认 250。 */
  rcpt?: (address: string) => string;
  /** DATA 结束后的响应；默认 `250 2.0.0 ok queued`。 */
  data?: string;
}

export interface FakeSmtp {
  readonly port: number;
  /** 收到 DATA 的次数。 */
  readonly messages: () => number;
  close(): Promise<void>;
}

export async function startFakeSmtp(
  script: FakeSmtpScript = {},
): Promise<FakeSmtp> {
  let messages = 0;
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const reply = (line: string) => socket.write(`${line}\r\n`);
    if (!script.silent) reply(script.greeting ?? '220 fake ESMTP');
    let buffer = '';
    let inData = false;
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          messages++;
          reply(script.data ?? '250 2.0.0 ok queued');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO')
          socket.write('250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') reply(script.auth ?? '235 2.7.0 ok');
        else if (verb === 'MAIL') reply(script.mailFrom ?? '250 2.1.0 ok');
        else if (verb === 'RCPT') {
          const address = /<([^>]*)>/.exec(line)?.[1]?.toLowerCase() ?? '';
          reply(script.rcpt?.(address) ?? '250 2.1.5 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 go ahead');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('假 SMTP 服务没有端口');
  return {
    port: address.port,
    messages: () => messages,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
