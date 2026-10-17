import type { z } from 'zod';
import {
  emptyRequestSchema,
  protectedErrors,
  type ApiOperation,
} from '../contract.js';
import { apiErrorSchemas } from '../errors.js';
import { cdrCountriesResponseSchema } from '../cdr-fields.js';
import { csvExportResponseSchema } from '../export.js';
import {
  portalCdrCountriesQuerySchema,
  portalCdrExportRequestSchema,
  portalCdrsQuerySchema,
  portalCdrsResponseSchema,
} from './cdrs.js';
import { portalHomeResponseSchema } from './home.js';
import {
  portalLedgerExportRequestSchema,
  portalLedgerQuerySchema,
  portalLedgerResponseSchema,
} from './ledger.js';

const noBody = emptyRequestSchema.optional();

/** 客户读操作：身份只来自会话，租户由 RLS 限定，所以隔离用例都是 tenant-read。 */
function customerOperation<
  const Id extends string,
  const Method extends ApiOperation['method'],
  const Path extends ApiOperation['path'],
  Request extends ApiOperation['request'],
  Response extends z.ZodType,
  const Errors extends Partial<Record<number, z.ZodType>>,
>(
  operationId: Id,
  method: Method,
  path: Path,
  request: Request,
  response: Response,
  extraResponses: Errors,
) {
  return {
    operationId,
    method,
    path,
    access: 'customer',
    isolationCase: 'tenant-read',
    request,
    responses: { ...protectedErrors, ...extraResponses, 200: response },
  } as const satisfies ApiOperation;
}

const get = <Query extends z.ZodType>(query: Query) => ({
  params: emptyRequestSchema,
  query,
  body: noBody,
});
const post = <Body extends z.ZodType>(body: Body) => ({
  params: emptyRequestSchema,
  query: emptyRequestSchema,
  body,
});

/**
 * 阶段 6 门户操作，按后端 PR 分组：每个后端 PR 把自己的一组并入 liveApiContract，
 * 同时补 handler、OpenAPI 覆盖和 IDOR 用例。在那之前不注册，路由表不会出现没有实现的端点。
 */
export const portalHomeApiContract = {
  portalHome: customerOperation(
    'portalHome',
    'GET',
    '/api/portal/home',
    get(emptyRequestSchema),
    portalHomeResponseSchema,
    { 404: apiErrorSchemas.NOT_FOUND },
  ),
} as const satisfies Record<string, ApiOperation>;

export const portalCdrApiContract = {
  portalCdrs: customerOperation(
    'portalCdrs',
    'GET',
    '/api/portal/cdrs',
    get(portalCdrsQuerySchema),
    portalCdrsResponseSchema,
    {},
  ),
  portalCdrCountries: customerOperation(
    'portalCdrCountries',
    'GET',
    '/api/portal/cdrs/countries',
    get(portalCdrCountriesQuerySchema),
    cdrCountriesResponseSchema,
    {},
  ),
  portalCdrsExport: customerOperation(
    'portalCdrsExport',
    'POST',
    '/api/portal/cdrs/export',
    post(portalCdrExportRequestSchema),
    csvExportResponseSchema,
    {},
  ),
} as const satisfies Record<string, ApiOperation>;

export const portalLedgerApiContract = {
  portalLedger: customerOperation(
    'portalLedger',
    'GET',
    '/api/portal/ledger',
    get(portalLedgerQuerySchema),
    portalLedgerResponseSchema,
    { 404: apiErrorSchemas.NOT_FOUND },
  ),
  portalLedgerExport: customerOperation(
    'portalLedgerExport',
    'POST',
    '/api/portal/ledger/export',
    post(portalLedgerExportRequestSchema),
    csvExportResponseSchema,
    {},
  ),
} as const satisfies Record<string, ApiOperation>;

export const portalApiContract = {
  ...portalHomeApiContract,
  ...portalCdrApiContract,
  ...portalLedgerApiContract,
} as const;

export type PortalApiOperationId = keyof typeof portalApiContract;
