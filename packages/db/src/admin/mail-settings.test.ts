import { describe, expect, it } from 'vitest';
import { isLoopbackMailHost, requiresNewPassword } from './mail-settings.js';

describe('requiresNewPassword', () => {
  const saved = {
    host: 'smtp.example.com',
    username: 'ops@example.com',
    passwordSet: true,
  };

  it('requires a password when none is stored', () => {
    expect(
      requiresNewPassword(
        { host: null, username: null, passwordSet: false },
        { host: 'smtp.example.com', username: 'ops@example.com' },
      ),
    ).toBe(true);
  });

  it('allows loopback with an empty username and no password', () => {
    for (const host of ['localhost', '127.0.0.1', '::1', '[::1]'])
      expect(
        requiresNewPassword(
          { host: null, username: null, passwordSet: false },
          { host, username: null },
        ),
        host,
      ).toBe(false);
  });

  it('ignores host case when the host did not really change', () => {
    expect(
      requiresNewPassword(saved, {
        host: 'SMTP.Example.COM',
        username: 'ops@example.com',
      }),
    ).toBe(false);
  });

  it('requires a password when the host or username changed', () => {
    expect(
      requiresNewPassword(saved, {
        host: 'smtp.attacker.test',
        username: 'ops@example.com',
      }),
    ).toBe(true);
    expect(
      requiresNewPassword(saved, {
        host: 'smtp.example.com',
        username: 'other@example.com',
      }),
    ).toBe(true);
  });

  it('does not treat loopback with a username as the development exception', () => {
    expect(
      requiresNewPassword(saved, { host: 'localhost', username: 'ops' }),
    ).toBe(true);
  });

  it('recognizes loopback hosts only', () => {
    expect(isLoopbackMailHost('localhost')).toBe(true);
    expect(isLoopbackMailHost('127.0.0.2')).toBe(true);
    expect(isLoopbackMailHost('smtp.example.com')).toBe(false);
    expect(isLoopbackMailHost(null)).toBe(false);
  });
});
