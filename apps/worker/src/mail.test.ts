import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MAIL_BACKOFF_SECONDS, mailBackoffSeconds } from '@fs-billing/db';
import type { MailTransport, OutgoingMail } from '@fs-billing/mailer';
import { runMailRequeue, runMailTest } from './mail-cli.js';

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
