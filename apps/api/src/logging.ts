import { pino, stdSerializers, type DestinationStream } from 'pino';
import { redactUrlForLog, scrubErrorForLog } from '@fs-billing/db';

/** Fastify 传给 `req` 序列化器的请求（`FastifyRequest`）里用到的字段。 */
interface LoggedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers?: Record<string, unknown>;
  readonly host?: string;
  readonly ip?: string;
  readonly socket?: { readonly remotePort?: number };
}

/**
 * 与 Fastify 默认的 `req` 序列化器同样的字段，但 URL 里号码类的查询参数掩码（话单搜索的 `callee` 带客户号码，
 * 阶段 9 PR 8，规则同 Worker 的 `maskNumber`，决定 37）。`loggerInstance` 自带的序列化器会盖过 Fastify 的默认值。
 */
export function serializeRequest(request: LoggedRequest) {
  return {
    method: request.method,
    url:
      typeof request.url === 'string'
        ? redactUrlForLog(request.url)
        : undefined,
    version: request.headers?.['accept-version'],
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}

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
        req: serializeRequest,
      },
    },
    destination,
  );
}
