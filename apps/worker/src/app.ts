import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import {
  authorizeRequestSchema,
  authorizeResponseSchema,
  cdrResponseSchema,
  healthResponseSchema,
} from '@fs-billing/shared';
import {
  AlertKeys,
  loadRatingTenant,
  withSystem,
  type Db,
} from '@fs-billing/db';
import {
  authorize,
  resolveBillingNumber,
  type RejectReason,
} from '@fs-billing/rating';
import { ingestCdr, postgresError, recordAlert } from './ingest.js';
import type { ChargeQueue } from './queue.js';

const sipCodes = {
  号码格式错误: 484,
  租户不存在: 404,
  租户已停用: 403,
  无费率: 404,
  余额不足: 402,
} as const satisfies Record<RejectReason, number>;

export interface WorkerDependencies {
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  db: Db;
  queue: ChargeQueue;
  security: { secret: string; allowedIps: readonly string[] };
}

export function createWorker(dependencies?: WorkerDependencies) {
  const app = Fastify(
    dependencies?.loggerInstance
      ? { loggerInstance: dependencies.loggerInstance }
      : { logger: dependencies?.logger ?? false },
  );
  app.get('/health', () =>
    healthResponseSchema.parse({ status: 'ok', service: 'worker' }),
  );
  if (!dependencies) return app;
  const { db, queue, security } = dependencies;
  const secretHash = createHash('sha256').update(security.secret).digest();
  app.register(async (routes) => {
    routes.addHook('onRequest', async (request, reply) => {
      if (!security.allowedIps.includes(request.ip))
        return reply.code(403).send({ error: 'IP 不在白名单' });
      const key = request.headers['x-billing-key'];
      if (
        typeof key !== 'string' ||
        !timingSafeEqual(createHash('sha256').update(key).digest(), secretHash)
      )
        return reply.code(401).send({ error: '密钥错误' });
    });
    routes.post('/authorize', async (request, reply) => {
      const parsed = authorizeRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        if (
          parsed.error.issues.some((issue) =>
            ['callee', 'dialedNumber', 'billingNumber'].includes(
              String(issue.path[0]),
            ),
          )
        ) {
          return reply.code(400).send({
            allowed: false,
            reason: '号码格式错误',
            sipCode: 484,
          });
        }
        return reply.code(400).send({ error: '授权请求格式错误' });
      }
      const tenant = parsed.data.tenant.toUpperCase();
      const resolved = resolveBillingNumber(parsed.data);
      if ('error' in resolved) {
        if (resolved.error === 'mismatch') {
          request.log.error(
            {
              uuid: parsed.data.uuid,
              tenant,
              dialedNumber: parsed.data.dialedNumber,
              callee: parsed.data.callee,
              luaBillingNumber: parsed.data.billingNumber,
              billingNumber: resolved.billingNumber,
            },
            '授权计费号码不一致',
          );
          return reply.code(400).send({ error: '授权计费号码不一致' });
        }
        return reply.code(400).send({
          allowed: false,
          reason: '号码格式错误',
          sipCode: 484,
        });
      }
      const { billingNumber } = resolved;
      try {
        const result = await withSystem(db, async (tx) =>
          authorize(
            await loadRatingTenant(tx, tenant),
            billingNumber,
            new Date(),
          ),
        );
        return authorizeResponseSchema.parse(
          result.allowed
            ? {
                allowed: true,
                maxSeconds: result.maxSeconds,
                billingNumber,
              }
            : {
                allowed: false,
                reason: result.reason,
                sipCode: sipCodes[result.reason],
              },
        );
      } catch (error) {
        request.log.error({ err: error }, '授权失败');
        return reply.code(503).send({ error: '授权服务暂不可用' });
      }
    });
    await routes.register((cdrRoutes, _options, done) => {
      // 由话单处理器解析 JSON，Fastify 不提前拒绝损坏的正文。
      cdrRoutes.removeAllContentTypeParsers();
      cdrRoutes.addContentTypeParser(
        '*',
        { parseAs: 'string' },
        (_request, body, done) => done(null, body),
      );
      cdrRoutes.post<{ Body: string }>('/cdr', async (request, reply) => {
        try {
          return cdrResponseSchema.parse(
            await ingestCdr(db, queue, request.body),
          );
        } catch (error) {
          const pg = postgresError(error);
          const partitionFailed =
            pg?.code === '23514' &&
            /no partition of relation .* found for row/.test(pg.message);
          request.log.error({ err: error }, '话单入库失败');
          try {
            await recordAlert(db, {
              kind: partitionFailed ? 'partition_failed' : 'cdr_failed',
              subjectKey: partitionFailed
                ? AlertKeys.partitionMissing
                : AlertKeys.cdrSave,
              description: pg?.message ?? '话单入库或任务入队失败',
              calls: 1,
            });
          } catch (alertError) {
            request.log.error({ err: alertError }, '话单失败告警保存失败');
          }
          return reply.code(503).send({ error: '话单保存失败，请重推' });
        }
      });
      done();
    });
  });
  return app;
}
