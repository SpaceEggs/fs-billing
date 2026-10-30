import { Writable } from 'node:stream';
import { createTransport } from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIL_BACKOFF_SECONDS, mailBackoffSeconds } from '@fs-billing/db';
import {
  adaptNodemailer,
  classifySmtpError,
  createMailTransport,
  smtpTransportOptions,
  summarizeSmtpError,
  type MailTransport,
  type OutgoingMail,
  type SmtpFailure,
} from './mail.js';
import { runMailRequeue, runMailTest } from './mail-cli.js';
import {
  mailpitSettings,
  startFakeSmtp,
  type FakeSmtp,
  type FakeSmtpScript,
} from '../test/mail-support.js';

const mail: OutgoingMail = {
  messageId: '<unit-test@fs-billing>',
  from: { name: 'FS-Billing 计费系统', address: 'billing@example.test' },
  to: ['alice@example.test', 'bob@example.test'],
  subject: '【测试邮件】FS-Billing',
  text: '正文',
  html: '<p>正文</p>',
};

describe('退避', () => {
  it('backoff schedule is 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours', () => {
    expect([1, 2, 3, 4, 5].map(mailBackoffSeconds)).toEqual([
      60, 300, 900, 3600, 10800,
    ]);
    expect(MAIL_BACKOFF_SECONDS).toEqual([60, 300, 900, 3600, 10800]);
    // 6 次尝试之间共 5 段等待，累计约 4 小时 20 分钟。
    const waits = [1, 2, 3, 4, 5].map(mailBackoffSeconds);
    expect(waits.map((seconds) => seconds / 60)).toEqual([1, 5, 15, 60, 180]);
    expect(waits.join('+')).toBe('60+300+900+3600+10800');
  });

  it('stays at the last step when more attempts are allowed', () => {
    expect(mailBackoffSeconds(6)).toBe(10800);
    expect(mailBackoffSeconds(20)).toBe(10800);
    expect(mailBackoffSeconds(0)).toBe(60);
  });
});

describe('SMTP 连接选项', () => {
  const base = mailpitSettings();

  it('requires starttls on a non loopback host and allows plain only on loopback', () => {
    expect(
      smtpTransportOptions({
        ...base,
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        user: 'u',
        pass: 'p',
      }).requireTLS,
    ).toBe(true);
    expect(
      smtpTransportOptions({ ...base, host: '127.0.0.1' }).requireTLS,
    ).toBe(false);
    expect(
      smtpTransportOptions({
        ...base,
        host: 'smtp.example.test',
        port: 465,
        secure: true,
        user: 'u',
        pass: 'p',
      }),
    ).toMatchObject({ secure: true, requireTLS: false });
  });

  it('strips the brackets of an IPv6 literal host', () => {
    expect(smtpTransportOptions({ ...base, host: '[::1]' }).host).toBe('::1');
    expect(smtpTransportOptions({ ...base, host: '::1' }).host).toBe('::1');
    expect(smtpTransportOptions({ ...base, host: 'localhost' }).host).toBe(
      'localhost',
    );
  });

  it('keeps certificate checks, auth and timeouts as configured and never turns on logging', () => {
    const options = smtpTransportOptions({
      ...base,
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      user: 'sender@example.test',
      pass: 'placeholder-auth-code',
      timeoutMs: 7000,
    });
    expect(options).toMatchObject({
      host: 'smtp.example.test',
      port: 465,
      auth: { user: 'sender@example.test', pass: 'placeholder-auth-code' },
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 7000,
      pool: true,
      maxConnections: 1,
      logger: false,
      debug: false,
    });
    expect(options).not.toHaveProperty('tls');
    expect(JSON.stringify(options)).not.toContain('rejectUnauthorized');
    expect(smtpTransportOptions(base)).not.toHaveProperty('auth');
    expect(smtpTransportOptions(base, { pool: false })).not.toHaveProperty(
      'pool',
    );
  });
});

describe('nodemailer 适配', () => {
  it('maps the json transport result: no recipient breakdown means all accepted', async () => {
    const transport = adaptNodemailer(createTransport({ jsonTransport: true }));
    const result = await transport.send(mail);
    expect(result.accepted).toEqual(mail.to);
    expect(result.rejected).toEqual([]);
    transport.close();
  });

  it('puts the outbox message id, display name, multipart body and auto headers on the wire', async () => {
    const mailer = createTransport({ streamTransport: true, buffer: true });
    let raw = '';
    const transport = adaptNodemailer({
      sendMail: async (options: Parameters<typeof mailer.sendMail>[0]) => {
        const info = (await mailer.sendMail(options)) as unknown as {
          message: Buffer;
        };
        raw = info.message.toString('utf8');
        return info;
      },
      close: () => mailer.close(),
    } as never);
    await transport.send(mail);
    expect(raw).toContain('Message-ID: <unit-test@fs-billing>');
    expect(raw).toMatch(/^Subject: =\?UTF-8\?/m);
    expect(raw).toMatch(/^From: =\?UTF-8\?[^<]*<billing@example\.test>/m);
    expect(raw).toContain('To: alice@example.test, bob@example.test');
    expect(raw).toContain('Auto-Submitted: auto-generated');
    expect(raw).toContain('X-Auto-Response-Suppress: All');
    expect(raw).toContain('multipart/alternative');
  });
});

describe('失败摘要', () => {
  it('keeps the response code and first line, drops addresses and caps the length', () => {
    const summary = summarizeSmtpError({
      code: 'EENVELOPE',
      responseCode: 550,
      response: '550 5.1.1 <victim@example.test>: user unknown\r\nsecond line',
      message: 'ignored',
    });
    expect(summary).toBe('EENVELOPE 550: 550 5.1.1 <地址>: user unknown');
    expect(summary).not.toContain('victim');
    expect(summary).not.toContain('second line');
    const long = summarizeSmtpError({ message: 'x'.repeat(1000) });
    expect(long).toHaveLength(300);
    expect(summarizeSmtpError(undefined)).toBe('未知错误');
    expect(
      summarizeSmtpError(new Error('connect ECONNREFUSED 127.0.0.1:1')),
    ).toContain('ECONNREFUSED');
  });
});

describe('失败分类', () => {
  const servers: FakeSmtp[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function failureOf(
    script: FakeSmtpScript,
    options: { auth?: boolean; timeoutMs?: number } = {},
  ): Promise<SmtpFailure> {
    const server = await startFakeSmtp(script);
    servers.push(server);
    const transport = createMailTransport(
      mailpitSettings({
        port: server.port,
        timeoutMs: options.timeoutMs ?? 5000,
        ...(options.auth ? { user: 'sender', pass: 'placeholder' } : {}),
      }),
      { pool: false },
    );
    try {
      await transport.send(mail);
    } catch (error) {
      return classifySmtpError(error);
    } finally {
      transport.close();
    }
    throw new Error('期望发送失败，但发送成功了');
  }

  it.each([
    {
      name: 'all recipients rejected with 550',
      script: { rcpt: () => '550 5.1.1 no such user' },
      expected: { class: 'permanent', scope: 'recipient' },
    },
    {
      name: 'a recipient deferred with 450',
      script: { rcpt: () => '450 4.2.0 mailbox busy' },
      expected: { class: 'retry', scope: 'recipient' },
    },
    {
      name: 'recipients throttled with a 5xx that says rate limited',
      script: { rcpt: () => '554 5.7.1 too many messages, rate limited' },
      expected: { class: 'retry', scope: 'recipient' },
    },
    {
      name: 'sender rejected with 550',
      script: { mailFrom: '550 5.7.1 sender not allowed' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'message rejected as spam after DATA',
      script: { data: '554 5.7.1 spam suspected' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'message deferred with 451 after DATA',
      script: { data: '451 4.3.0 try later' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'a 5xx that says the sending frequency is limited',
      script: { data: '550 Mail frequency limited, send later' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'the DATA command refused with 451',
      script: { dataCommand: '451 4.3.0 temporary local problem' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'the DATA command refused with 554',
      script: { dataCommand: '554 5.5.1 no valid recipients' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'a 552 size error after DATA that says exceeds',
      script: { data: '552 5.3.4 message size exceeds fixed limit' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'a 552 mailbox full at RCPT that says exceeded',
      script: { rcpt: () => '552 5.2.2 mailbox full, quota exceeded' },
      expected: { class: 'permanent', scope: 'recipient' },
    },
    {
      // QQ 邮箱实测（PR #79，docs/evidence/phase-9/qq-item7-bounce.txt）：收件人不存在在 DATA 之后以 EMESSAGE 550 返回。
      name: 'QQ rejecting a non-existent recipient after DATA',
      script: {
        data: '550 The recipient may contain a non-existent account, please check the recipient address.',
      },
      expected: { class: 'permanent', scope: 'recipient' },
    },
    {
      name: 'a daily quota 5xx after DATA',
      script: { data: '550 Daily quota exceeded, try again tomorrow' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'a daily sending limit in Chinese after DATA',
      script: { data: '550 已达到当日发送上限' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'a daily sending limit in English after DATA',
      script: { data: '550 Daily sending limit reached' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'a quota that says try again tomorrow after DATA',
      script: { data: '550 quota used up today, try again tomorrow' },
      expected: { class: 'retry', scope: 'smtp' },
    },
    {
      name: 'a message size error that mentions the sending limit',
      script: { data: '552 Message size exceeds sending limit' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'a Chinese mailbox-full error that mentions the day',
      script: { data: '550 当日收件箱已满' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'a mailbox-full error whose quota text mentions today',
      script: { data: '552 mailbox full, quota exceeded today' },
      expected: { class: 'permanent', scope: 'smtp' },
    },
    {
      name: 'service closing with 421 at the greeting',
      script: { greeting: '421 4.3.2 service not available' },
      expected: { class: 'retry', scope: 'smtp' },
    },
  ] as const)('classifies $name', async ({ script, expected }) => {
    expect(await failureOf(script)).toMatchObject(expected);
  });

  it('classifies a rejected login as an authentication failure', async () => {
    const failure = await failureOf(
      { auth: '535 5.7.8 Login fail' },
      { auth: true },
    );
    expect(failure).toMatchObject({ class: 'auth', scope: 'smtp' });
    expect(failure.summary).toContain('535');
    expect(failure.summary).not.toContain('placeholder');
  });

  it('classifies a refused connection as retryable', async () => {
    const closed = await startFakeSmtp();
    const { port } = closed;
    await closed.close();
    const transport = createMailTransport(
      mailpitSettings({ port, timeoutMs: 2000 }),
      { pool: false },
    );
    const failure = await transport.send(mail).then(
      () => undefined,
      (error: unknown) => classifySmtpError(error),
    );
    expect(failure).toMatchObject({ class: 'retry', scope: 'smtp' });
  });

  it('classifies a silent server as a retryable timeout', async () => {
    const failure = await failureOf({ silent: true }, { timeoutMs: 1000 });
    expect(failure).toMatchObject({ class: 'retry', scope: 'smtp' });
    expect(failure.summary).toContain('ETIMEDOUT');
  });

  it('treats a partly rejected envelope as delivered with the rejected addresses listed', async () => {
    const server = await startFakeSmtp({
      rcpt: (address) =>
        address === 'bob@example.test' ? '550 5.1.1 no such user' : '250 ok',
    });
    servers.push(server);
    const transport = createMailTransport(
      mailpitSettings({ port: server.port }),
      { pool: false },
    );
    const result = await transport.send(mail);
    transport.close();
    expect(result.accepted).toEqual(['alice@example.test']);
    expect(result.rejected).toEqual(['bob@example.test']);
    expect(server.messages()).toBe(1);
  });

  it('puts the rejected recipients of a thrown envelope error on the failure', async () => {
    const server = await startFakeSmtp({
      rcpt: () => '550 5.1.1 no such user',
    });
    servers.push(server);
    const transport = createMailTransport(
      mailpitSettings({ port: server.port }),
      { pool: false },
    );
    const failure = await transport.send(mail).then(
      () => undefined,
      (error: unknown) => classifySmtpError(error),
    );
    transport.close();
    expect(failure).toMatchObject({ class: 'permanent', scope: 'recipient' });
    expect([...(failure?.rejected ?? [])].sort()).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
  });

  it('names the single recipient when the whole message is refused after DATA for that recipient', () => {
    const failure = classifySmtpError({
      code: 'EMESSAGE',
      command: 'DATA',
      responseCode: 550,
      response:
        '550 The recipient may contain a non-existent account, please check the recipient address.',
    });
    expect(failure).toMatchObject({ class: 'permanent', scope: 'recipient' });
    // 措辞必须点名收件人 / 账号不存在：其余 5xx 仍是全局 smtp 问题。
    for (const response of [
      '554 5.7.1 spam suspected',
      '552 message size exceeds fixed limit',
      '552 mailbox full, quota exceeded',
      '550 Mail content rejected',
    ])
      expect(
        classifySmtpError({
          code: 'EMESSAGE',
          command: 'DATA',
          responseCode: 550,
          response,
        }),
      ).toMatchObject({ class: 'permanent', scope: 'smtp' });
  });

  it('treats a local oversize or empty message as permanent, not unknown', () => {
    expect(
      classifySmtpError({
        code: 'EMESSAGE',
        command: 'MAIL FROM',
        message: 'Message size larger than allowed 1000',
      }),
    ).toMatchObject({ class: 'permanent', scope: 'smtp' });
    // 有响应码的 EMESSAGE 按响应码走：DATA 之后的 4xx 重试。
    expect(
      classifySmtpError({
        code: 'EMESSAGE',
        command: 'DATA',
        responseCode: 451,
      }),
    ).toMatchObject({ class: 'retry' });
  });

  it('only clear rate limit wording turns a 5xx into a retry', () => {
    const permanent = (response: string, responseCode = 552) =>
      classifySmtpError({
        code: 'EMESSAGE',
        command: 'DATA',
        responseCode,
        response,
      });
    expect(permanent('552 message size exceeds limit').class).toBe('permanent');
    expect(permanent('552 mailbox full').class).toBe('permanent');
    expect(permanent('552 收件人超过限制').class).toBe('permanent');
    expect(permanent('550 Mail frequency limited').class).toBe('retry');
    expect(permanent('554 too many messages, rate limited').class).toBe(
      'retry',
    );
    expect(permanent('550 发送过于频繁，请稍后再试').class).toBe('retry');
  });

  it('retries errors it does not recognise, never drops the mail', () => {
    expect(classifySmtpError(new Error('boom'))).toMatchObject({
      class: 'retry',
      scope: 'smtp',
    });
    expect(classifySmtpError('weird')).toMatchObject({ class: 'retry' });
    expect(classifySmtpError(null)).toMatchObject({ class: 'retry' });
  });

  it('classifies handcrafted nodemailer error shapes', () => {
    expect(
      classifySmtpError({
        code: 'EAUTH',
        responseCode: 535,
        response: '535 x',
      }),
    ).toMatchObject({ class: 'auth' });
    expect(
      classifySmtpError({ code: 'ESOCKET', originalCode: 'ECONNRESET' }),
    ).toMatchObject({ class: 'retry' });
    expect(classifySmtpError({ code: 'ECONNECTION' })).toMatchObject({
      class: 'retry',
    });
    expect(classifySmtpError({ code: 'EDNS' })).toMatchObject({
      class: 'retry',
    });
    expect(
      classifySmtpError({
        code: 'EENVELOPE',
        command: 'RCPT TO',
        rejectedErrors: [],
      }),
    ).toMatchObject({ class: 'permanent', scope: 'recipient' });
    expect(
      classifySmtpError({
        code: 'EENVELOPE',
        command: 'RCPT TO',
        rejectedErrors: [{ responseCode: 550 }, { responseCode: 451 }],
      }),
    ).toMatchObject({ class: 'retry', scope: 'recipient' });
    expect(classifySmtpError({ code: 'EENVELOPE' })).toMatchObject({
      class: 'permanent',
      scope: 'recipient',
    });
    expect(
      classifySmtpError({ code: 'EMESSAGE', responseCode: 554 }),
    ).toMatchObject({
      class: 'permanent',
      scope: 'smtp',
    });
    expect(classifySmtpError({ code: 'ECONFIG' })).toMatchObject({
      class: 'permanent',
    });
  });
});

describe('mail:test', () => {
  const sink = () => {
    let text = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        text += chunk.toString('utf8');
        callback();
      },
    });
    return { stream, text: () => text };
  };
  const run = async (
    argv: string[],
    env: Record<string, string>,
    transport?: MailTransport,
  ) => {
    const out = sink();
    const err = sink();
    const code = await runMailTest(
      argv,
      env,
      { stdout: out.stream, stderr: err.stream },
      transport ? { createTransport: () => transport } : {},
    );
    return { code, out: out.text(), err: err.text() };
  };
  const env = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: '1025',
    SMTP_SECURE: 'false',
    MAIL_FROM: 'billing@example.test',
  };
  const sent: OutgoingMail[] = [];
  const recording: MailTransport = {
    send: (message) => {
      sent.push(message);
      return Promise.resolve({
        accepted: message.to,
        rejected: [],
        response: '250 2.0.0 ok queued as abc',
      });
    },
    close: () => undefined,
  };

  it('sends one test mail to every --to address and prints the server response', async () => {
    sent.length = 0;
    const result = await run(
      ['--', '--to', 'a@example.test,b@example.test', '--to', 'c@example.test'],
      env,
      recording,
    );
    expect(result.code).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
    expect(sent[0]!.subject).toBe('【测试邮件】FS-Billing');
    expect(sent[0]!.from.address).toBe('billing@example.test');
    expect(result.out).toContain('发送成功');
    expect(result.out).toContain('接受 3 个收件人，拒绝 0 个');
    expect(result.out).toContain('服务器响应：250 2.0.0 ok queued as abc');
    // 输出里不重复收件人地址。
    expect(result.out).not.toContain('a@example.test');
  });

  it('reports the failure class and never prints the password or the addresses', async () => {
    const failing: MailTransport = {
      send: () =>
        Promise.reject(
          Object.assign(new Error('Invalid login'), {
            code: 'EAUTH',
            responseCode: 535,
            response: '535 5.7.8 Login fail for owner@example.test',
          }),
        ),
      close: () => undefined,
    };
    const result = await run(
      ['--to', 'a@example.test'],
      {
        ...env,
        SMTP_HOST: 'smtp.qq.com',
        SMTP_PORT: '465',
        SMTP_SECURE: 'true',
        SMTP_USER: 'owner@example.test',
        SMTP_PASS: 'placeholder-auth-code',
        MAIL_FROM: 'owner@example.test',
      },
      failing,
    );
    expect(result.code).toBe(1);
    expect(result.err).toContain('认证失败');
    expect(result.err).toContain('535');
    expect(result.err).not.toContain('placeholder-auth-code');
    expect(result.err).not.toContain('owner@example.test');
  });

  it('rejects bad arguments and configuration without sending', async () => {
    sent.length = 0;
    expect((await run([], env, recording)).code).toBe(1);
    expect((await run(['--to', 'nope'], env, recording)).err).toContain(
      '--to 需要 1 到 5 个有效的邮箱地址',
    );
    expect((await run(['--unknown'], env, recording)).code).toBe(1);
    const unset = await run(['--to', 'a@example.test'], {}, recording);
    expect(unset.err).toContain('SMTP_HOST 未设置');
    const inconsistent = await run(
      ['--to', 'a@example.test'],
      { ...env, SMTP_USER: 'someone-without-password' },
      recording,
    );
    expect(inconsistent.code).toBe(1);
    expect(inconsistent.err).not.toContain('someone-without-password');
    expect(sent).toHaveLength(0);
  });
});

describe('mail:requeue 参数', () => {
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    let err = '';
    const code = await runMailRequeue(argv, env, {
      stdout: new Writable({ write: (_c, _e, done) => done() }),
      stderr: new Writable({
        write(chunk: Buffer, _encoding, done) {
          err += chunk.toString('utf8');
          done();
        },
      }),
    });
    return { code, err };
  };

  it('needs exactly one of --id and --since, and valid values', async () => {
    expect((await run([])).err).toContain('二选一');
    expect(
      (
        await run([
          '--id',
          '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b',
          '--since',
          '2026-10-29',
        ])
      ).err,
    ).toContain('二选一');
    expect((await run(['--id', 'abc'])).err).toContain('不是有效的 UUID');
    expect((await run(['--since', 'yesterday'])).err).toContain('--since');
    expect(
      (await run(['--id', '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'])).err,
    ).toContain('APP_DATABASE_URL');
  });
});
