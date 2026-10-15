import type { FastifyInstance } from 'fastify';
import { liveApiContract } from './routes/contract.js';
import { z } from 'zod';

const documentSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
const operationSchema = z.object({
  operationId: z.string().min(1),
  'x-access': z.enum([
    'public',
    'session',
    'authenticated',
    'customer',
    'admin',
  ]),
  'x-isolation-case': z.string().min(1),
});
export async function generateOpenApi(app: FastifyInstance) {
  await app.ready();
  const document = app.swagger();
  const parsed = documentSchema.parse(document);
  const operations = Object.entries(parsed.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) =>
        ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(
          method,
        ),
      )
      .map(([method, value]) => ({
        path,
        method,
        ...operationSchema.parse(value),
      })),
  );
  const expected = Object.values(liveApiContract);
  if (
    !operations.length ||
    operations.length !== expected.length ||
    new Set(operations.map((op) => op.operationId)).size !== operations.length
  )
    throw new Error('OpenAPI operation coverage differs from apiContract');
  for (const contract of expected) {
    const operation = operations.find(
      (op) => op.operationId === contract.operationId,
    );
    if (
      !operation ||
      operation.path !== contract.path ||
      operation.method !== contract.method.toLowerCase() ||
      operation['x-access'] !== contract.access ||
      operation['x-isolation-case'] !== contract.isolationCase
    )
      throw new Error(`OpenAPI contract mismatch: ${contract.operationId}`);
  }
  return { document, operations };
}
