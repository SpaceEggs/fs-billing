import { pino, stdSerializers, type DestinationStream } from 'pino';
import { scrubErrorForLog } from '@fs-billing/db';

export function createApiLogger(destination?: DestinationStream) {
  return pino(
    {
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.body',
        'res.headers.set-cookie',
      ],
      // drizzle 的 DrizzleQueryError 在 message / stack / params 里带绑定实参（话单搜索绑定的是被叫号码）：
      // 与 Worker 一致，序列化时去掉（阶段 9 PR 5）。
      serializers: {
        err: (error: unknown) =>
          scrubErrorForLog(stdSerializers.err(error as Error)),
      },
    },
    destination,
  );
}
