import { describe, expect, it } from 'vitest';
import { workerEnvironmentSchema } from './config.js';

const environment = {
  APP_DATABASE_URL:
    'postgresql://fs_billing_app:local@127.0.0.1:5432/fs_billing',
  WORKER_SHARED_KEY: 'test-worker-key-123456',
  WORKER_ALLOWED_IPS: '127.0.0.1, 10.0.0.10',
};

describe('Worker 启动配置边界', () => {
  it('默认只绑定回环，解析内网地址、端口与 IP 白名单', () => {
    expect(workerEnvironmentSchema.parse(environment)).toMatchObject({
      WORKER_HOST: '127.0.0.1',
      WORKER_PORT: 3001,
      WORKER_ALLOWED_IPS: ['127.0.0.1', '10.0.0.10'],
    });
    expect(
      workerEnvironmentSchema.parse({
        ...environment,
        WORKER_HOST: '192.168.1.2',
        WORKER_PORT: '3002',
      }).WORKER_HOST,
    ).toBe('192.168.1.2');
  });

  it.each(['0.0.0.0', '::', '8.8.8.8', 'localhost', '172.32.0.1'])(
    '拒绝监听 %s',
    (host) => {
      expect(() =>
        workerEnvironmentSchema.parse({ ...environment, WORKER_HOST: host }),
      ).toThrow();
    },
  );

  it.each([
    { WORKER_PORT: '0' },
    { WORKER_PORT: '65536' },
    { WORKER_PORT: '1.5' },
    { WORKER_ALLOWED_IPS: '' },
    { WORKER_ALLOWED_IPS: '127.0.0.1,' },
    { WORKER_ALLOWED_IPS: 'invalid' },
    { WORKER_SHARED_KEY: 'short' },
    { WORKER_SHARED_KEY: undefined },
    { WORKER_ALLOWED_IPS: undefined },
    { APP_DATABASE_URL: 'postgresql://fs_billing:local@127.0.0.1/fs_billing' },
    { APP_DATABASE_URL: 'https://localhost' },
  ])('拒绝无效配置 %j', (invalid) => {
    expect(() =>
      workerEnvironmentSchema.parse({ ...environment, ...invalid }),
    ).toThrow();
  });
});
