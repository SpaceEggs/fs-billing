import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  decimal,
  formatRateCsv,
  parseRateCsv,
  rate,
  type Currency,
} from '@fs-billing/rating';
import {
  adminRateEntrySchema,
  adminRateExportRequestSchema,
  adminRateCancelFutureVersionRequestSchema,
  adminRateImportCommitRequestSchema,
  adminRatesQuerySchema,
  createAdminRateEntriesSchema,
  createAdminRateRequestSchemas,
  DEFAULT_ADMIN_CSV_MAX_BYTES,
  DEFAULT_ADMIN_RATE_MAX_ROWS,
  DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS as DEFAULT_PREVIEW_TTL_MS,
  DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS as DEFAULT_CANCEL_CLOCK_SKEW_MARGIN_SECONDS,
  type AdminRateChange,
  type AdminRateEntry,
  type AdminRateVersion,
  type AdminRateSchedule,
  type AdminRateEditRequest,
  type AdminRateImportPreviewRequest,
  type AdminRateCopyPreviewRequest,
  type AdminRateImportCommitRequest,
  type AdminRateExportRequest,
  type AdminRateCancelFutureVersionRequest,
  type AdminRatePreviewResponse,
  type AdminRatesQuery,
  type AuditPayload,
} from '@fs-billing/shared';
import { lockTenants, withAdmin, type Db, type Tx } from '../client.js';
import { databaseNow } from '../clock.js';
import { createRateVersion } from '../rates.js';
import { adminRatePreviews, rateEntries, rateVersions } from '../schema.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';
import { readTenantCore } from './tenants.js';
import {
  ratePreviewPayloadSchema,
  type RatePreviewPayload,
} from './rate-preview.js';

type Mutation<Request> = {
  db: Db | Tx;
  actor: AuditPayload['actor'];
  tenantId: string;
  request: Request;
};

function previewPayloadText(key: keyof RatePreviewPayload) {
  return sql<
    string | null
  >`${adminRatePreviews.payload}->>${sql.raw(`'${key}'`)}`;
}

export type AdminRatesServiceOptions = {
  rateRequests?: ReturnType<typeof createAdminRateRequestSchemas>;
  previewTtlMs?: number;
  cancelClockSkewMarginSeconds?: number;
  maxCsvBytes?: number;
  maxRows?: number;
};

function parseRequest<T>(schema: z.ZodType<T>, request: unknown): T {
  const result = schema.safeParse(request);
  if (!result.success)
    throw new AdminServiceError('VALIDATION_ERROR', '费率请求格式或排期无效');
  return result.data;
}
async function readVersion(
  tx: Tx,
  tenantId: string,
  versionId: string,
): Promise<AdminRateVersion> {
  const [version] = await tx
    .select()
    .from(rateVersions)
    .where(
      and(eq(rateVersions.id, versionId), eq(rateVersions.tenantId, tenantId)),
    );
  if (!version) throw new AdminServiceError('NOT_FOUND', '费率版本不存在');
  const entries = await tx
    .select({
      prefix: rateEntries.prefix,
      country: rateEntries.country,
      iso: rateEntries.iso,
      description: rateEntries.description,
      rate: rateEntries.rate,
    })
    .from(rateEntries)
    .where(eq(rateEntries.rateVersionId, version.id))
    .orderBy(asc(rateEntries.prefix));
  return {
    id: version.id,
    effectiveFrom: version.effectiveFrom.toISOString(),
    entries,
  };
}
async function assertBase(
  tx: Tx,
  tenantId: string,
  versionId: string,
  stale = false,
) {
  const [latest] = await tx
    .select({ id: rateVersions.id })
    .from(rateVersions)
    .where(eq(rateVersions.tenantId, tenantId))
    .orderBy(desc(rateVersions.effectiveFrom))
    .limit(1);
  if (!latest || latest.id !== versionId.toLowerCase())
    throw new AdminServiceError(
      stale ? 'PREVIEW_STALE' : 'RATE_VERSION_CONFLICT',
      '费率基准版本已变化',
    );
}
function differences(
  before: AdminRateEntry[],
  after: AdminRateEntry[],
): AdminRateChange[] {
  const previous = new Map(before.map((entry) => [entry.prefix, entry]));
  const changes: AdminRateChange[] = [];
  for (const entry of after) {
    const old = previous.get(entry.prefix);
    if (!old) changes.push({ kind: 'added', after: entry });
    else if (
      old.iso !== entry.iso ||
      old.description !== entry.description ||
      old.country !== entry.country ||
      !decimal(old.rate).eq(entry.rate)
    )
      changes.push({ kind: 'modified', before: old, after: entry });
    previous.delete(entry.prefix);
  }
  for (const entry of previous.values())
    changes.push({ kind: 'deleted', before: entry });
  return changes;
}
function conflict(error: unknown): never {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      current.message.includes('已生效的费率版本不可删除') ||
      current.message.includes('新版本的生效时间必须晚于当前版本') ||
      current.message.includes('已排定 ') ||
      ('code' in current &&
        current.code === '23505' &&
        'constraint' in current &&
        typeof current.constraint === 'string' &&
        current.constraint.includes('rate_versions'))
    ) {
      throw new AdminServiceError(
        'RATE_VERSION_CONFLICT',
        '费率版本已变化，请刷新',
      );
    }
  }
  throw error;
}

export function createAdminRatesService(
  options: AdminRatesServiceOptions = {},
) {
  const requests = options.rateRequests ?? createAdminRateRequestSchemas();
  const ttl = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
  const margin =
    options.cancelClockSkewMarginSeconds ??
    DEFAULT_CANCEL_CLOCK_SKEW_MARGIN_SECONDS;
  const maxBytes = options.maxCsvBytes ?? DEFAULT_ADMIN_CSV_MAX_BYTES;
  const maxRows = options.maxRows ?? DEFAULT_ADMIN_RATE_MAX_ROWS;
  for (const value of [ttl, maxBytes, maxRows])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('费率配置必须为正整数');
  if (!Number.isFinite(margin) || margin < 0)
    throw new Error('取消余量必须为非负秒数');
  const entriesSchema = createAdminRateEntriesSchema(maxRows);
  async function savePreview(
    tx: Tx,
    tenantId: string,
    preview: RatePreviewPayload,
    before: AdminRateEntry[],
    currency: Currency,
    encoding: 'UTF-8' | 'GBK',
  ): Promise<AdminRatePreviewResponse> {
    await tx
      .delete(adminRatePreviews)
      .where(
        sql`${adminRatePreviews.expiresAt} < clock_timestamp() - interval '1 day'`,
      );
    const previewId = randomUUID();
    const expiresAt = new Date((await databaseNow(tx)).getTime() + ttl);
    await tx
      .insert(adminRatePreviews)
      .values({ id: previewId, tenantId, payload: preview, expiresAt });
    const changes = differences(before, preview.entries);
    return {
      ok: true,
      previewId,
      expiresAt: expiresAt.toISOString(),
      currency,
      encoding,
      changes,
      counts: {
        added: changes.filter((change) => change.kind === 'added').length,
        modified: changes.filter((change) => change.kind === 'modified').length,
        deleted: changes.filter((change) => change.kind === 'deleted').length,
      },
    };
  }
  async function writeVersion(
    tx: Tx,
    input: {
      actor: AuditPayload['actor'];
      tenantId: string;
      entries: AdminRateEntry[];
      schedule: AdminRateSchedule;
    } & (
      | { action: 'rate_entry_edit' | 'rate_import' }
      | { action: 'rate_copy'; sourceTenantId: string; sourceVersionId: string }
    ),
  ) {
    const tenant = await readTenantCore(tx, input.tenantId);
    const version = await createRateVersion(
      tx,
      tenant.id,
      input.entries.map((entry) => ({
        prefix: entry.prefix,
        country: entry.country,
        iso: entry.iso,
        description: entry.description,
        perMinute: rate(tenant.currency, entry.rate),
      })),
      {
        adminId: input.actor.id,
        ...(input.schedule.kind === 'scheduled'
          ? { effectiveFrom: new Date(input.schedule.effectiveFrom) }
          : {}),
      },
    );
    const auditId = randomUUID();
    const envelope = {
      id: auditId,
      actor: input.actor,
      occurredAt: (await databaseNow(tx)).toISOString(),
      tenantId: tenant.id,
      target: { kind: 'rate_version', id: version.id },
    } as const;
    const content = {
      summary: input.action,
      changes: [],
      rateVersionId: version.id,
    };
    await writeAudit(
      tx,
      input.action === 'rate_copy'
        ? {
            ...envelope,
            action: input.action,
            content: {
              ...content,
              sourceTenantId: input.sourceTenantId,
              sourceVersionId: input.sourceVersionId,
            },
          }
        : { ...envelope, action: input.action, content },
    );
    return { auditId, version: await readVersion(tx, tenant.id, version.id) };
  }
  async function getRates({
    db,
    tenantId,
    query,
  }: {
    db: Db | Tx;
    tenantId: string;
    query: AdminRatesQuery;
  }) {
    const input = adminRatesQuerySchema.parse(query);
    return withAdmin(db, async (tx) => {
      const tenant = await readTenantCore(tx, tenantId);
      const now = await databaseNow(tx);
      const versions = await tx
        .select()
        .from(rateVersions)
        .where(eq(rateVersions.tenantId, tenant.id))
        .orderBy(desc(rateVersions.effectiveFrom));
      const current = versions.find((version) => version.effectiveFrom <= now);
      if (!current)
        throw new AdminServiceError('NOT_FOUND', '当前费率版本不存在');
      const read = async (id: string) => {
        const version = await readVersion(tx, tenant.id, id);
        const search = input.search?.toLocaleLowerCase();
        return search
          ? {
              ...version,
              entries: version.entries.filter(
                (entry) =>
                  entry.prefix.includes(search) ||
                  entry.country.toLocaleLowerCase().includes(search) ||
                  entry.iso.toLocaleLowerCase().includes(search) ||
                  entry.description.toLocaleLowerCase().includes(search),
              ),
            }
          : version;
      };
      return {
        currency: tenant.currency,
        current: await read(current.id),
        scheduled: await Promise.all(
          versions
            .filter((version) => version.effectiveFrom > now)
            .reverse()
            .map((version) => read(version.id)),
        ),
      };
    });
  }
  async function editRate({
    db,
    actor,
    tenantId,
    request,
  }: Mutation<AdminRateEditRequest>) {
    const input = parseRequest(requests.editRequest, request);
    try {
      return await withAdmin(db, async (tx) => {
        await lockTenants(tx, [tenantId]);
        await readTenantCore(tx, tenantId);
        parseRequest(requests.schedule, input.schedule);
        await assertBase(tx, tenantId, input.baseVersionId);
        const base = await readVersion(tx, tenantId, input.baseVersionId);
        const entries = entriesSchema.parse([
          ...base.entries.filter(
            (entry) => entry.prefix !== input.entry.prefix,
          ),
          input.entry,
        ]);
        return writeVersion(tx, {
          actor,
          tenantId,
          entries,
          schedule: input.schedule,
          action: 'rate_entry_edit',
        });
      });
    } catch (error) {
      return conflict(error);
    }
  }
  async function importPreview({
    db,
    actor,
    tenantId,
    request,
  }: Mutation<AdminRateImportPreviewRequest>): Promise<AdminRatePreviewResponse> {
    const input = parseRequest(requests.importPreviewRequest, request);
    const bytes = Buffer.from(input.file.contentBase64, 'base64');
    if (bytes.length > maxBytes)
      throw new AdminServiceError('CSV_LIMIT_EXCEEDED', 'CSV 文件超限');
    let text: string;
    let encoding: 'UTF-8' | 'GBK' = 'UTF-8';
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      try {
        text = new TextDecoder('gbk', { fatal: true }).decode(bytes);
        encoding = 'GBK';
      } catch {
        throw new AdminServiceError(
          'CSV_ENCODING_UNSUPPORTED',
          'CSV 必须为 UTF-8 或 GBK',
        );
      }
    }
    const data = await withAdmin(db, async (tx) => {
      const tenant = await readTenantCore(tx, tenantId);
      await assertBase(tx, tenant.id, input.baseVersionId);
      return {
        tenant,
        base: await readVersion(tx, tenant.id, input.baseVersionId),
      };
    });
    const result = parseRateCsv(text, data.tenant.currency, {
      validateEntry: (entry) => {
        const parsed = adminRateEntrySchema.safeParse({
          prefix: entry.prefix,
          iso: entry.iso,
          country: entry.country,
          description: entry.description,
          rate: entry.perMinute.perMinute.toFixed(),
        });
        return parsed.success ? undefined : parsed.error.issues[0]?.message;
      },
    });
    const errors = result.ok ? [] : [...result.errors];
    if (errors.length)
      return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
    if (!result.ok) throw new Error('CSV 校验失败但未返回错误行');
    if (result.entries.length > maxRows)
      throw new AdminServiceError('CSV_LIMIT_EXCEEDED', 'CSV 行数超限');
    const entries = entriesSchema.parse(
      result.entries.map((entry) => ({
        prefix: entry.prefix,
        country: entry.country,
        iso: entry.iso,
        description: entry.description,
        rate: entry.perMinute.perMinute.toFixed(),
      })),
    );
    return withAdmin(db, (tx) =>
      savePreview(
        tx,
        data.tenant.id,
        {
          kind: 'import',
          actorId: actor.id.toLowerCase(),
          pathTenantId: data.tenant.id,
          baseVersionId: data.base.id,
          entries,
          schedule: input.schedule,
          fileDigest: createHash('sha256').update(bytes).digest('hex'),
        },
        data.base.entries,
        data.tenant.currency,
        encoding,
      ),
    );
  }
  async function copyPreview({
    db,
    actor,
    tenantId,
    request,
  }: Mutation<AdminRateCopyPreviewRequest>) {
    const input = parseRequest(requests.copyPreviewRequest, request);
    if (tenantId.toLowerCase() === input.targetTenantId.toLowerCase())
      throw new AdminServiceError('VALIDATION_ERROR', '来源与目标租户必须不同');
    const data = await withAdmin(db, async (tx) => {
      const source = await readTenantCore(tx, tenantId);
      const target = await readTenantCore(tx, input.targetTenantId);
      const version = await readVersion(tx, source.id, input.sourceVersionId);
      if (source.currency !== target.currency)
        throw new AdminServiceError('CURRENCY_MISMATCH', '来源与目标币种不符');
      await assertBase(tx, target.id, input.targetBaseVersionId);
      return {
        source,
        target,
        version,
        base: await readVersion(tx, target.id, input.targetBaseVersionId),
      };
    });
    const entries = entriesSchema.parse(data.version.entries);
    return withAdmin(db, (tx) =>
      savePreview(
        tx,
        data.target.id,
        {
          kind: 'copy',
          actorId: actor.id.toLowerCase(),
          pathTenantId: data.source.id,
          sourceVersionId: data.version.id,
          baseVersionId: data.base.id,
          entries,
          schedule: input.schedule,
        },
        data.base.entries,
        data.target.currency,
        'UTF-8',
      ),
    );
  }
  async function commit(
    kind: RatePreviewPayload['kind'],
    { db, actor, tenantId, request }: Mutation<AdminRateImportCommitRequest>,
  ) {
    const input = adminRateImportCommitRequestSchema.parse(request);
    function isPreviewStale(
      preview: { consumedAt: Date | null } & {
        [
          Key in keyof Pick<
            RatePreviewPayload,
            'kind' | 'pathTenantId' | 'actorId'
          >
        ]: string | null;
      },
    ) {
      return (
        preview.consumedAt !== null ||
        preview.kind !== kind ||
        preview.pathTenantId?.toLowerCase() !== tenantId.toLowerCase() ||
        preview.actorId?.toLowerCase() !== actor.id.toLowerCase()
      );
    }
    try {
      const response = await withAdmin(db, async (tx) => {
        const [initial] = await tx
          .select({
            tenantId: adminRatePreviews.tenantId,
            consumedAt: adminRatePreviews.consumedAt,
            kind: previewPayloadText('kind'),
            pathTenantId: previewPayloadText('pathTenantId'),
            actorId: previewPayloadText('actorId'),
          })
          .from(adminRatePreviews)
          .where(eq(adminRatePreviews.id, input.previewId));
        if (!initial || isPreviewStale(initial))
          throw new AdminServiceError('PREVIEW_STALE', '预览已失效');
        await lockTenants(tx, [initial.tenantId]);
        const [row] = await tx
          .select()
          .from(adminRatePreviews)
          .where(eq(adminRatePreviews.id, input.previewId));
        if (!row) throw new AdminServiceError('PREVIEW_STALE', '预览已失效');
        const payload = ratePreviewPayloadSchema.safeParse(row.payload);
        if (
          !payload.success ||
          isPreviewStale({ ...payload.data, consumedAt: row.consumedAt })
        )
          throw new AdminServiceError('PREVIEW_STALE', '预览已失效');
        const preview = {
          ...payload.data,
          tenantId: row.tenantId,
          expiresAt: row.expiresAt,
        };
        const now = await databaseNow(tx);
        if (preview.expiresAt <= now)
          throw new AdminServiceError('PREVIEW_EXPIRED', '预览已过期');
        const schedule = requests.schedule.safeParse(preview.schedule);
        if (!schedule.success)
          throw new AdminServiceError('PREVIEW_STALE', '预览排期已失效');
        await assertBase(tx, preview.tenantId, preview.baseVersionId, true);
        await tx
          .update(adminRatePreviews)
          .set({ consumedAt: now })
          .where(eq(adminRatePreviews.id, input.previewId));
        if (preview.kind === 'copy') {
          await readVersion(tx, preview.pathTenantId, preview.sourceVersionId);
          return writeVersion(tx, {
            actor,
            tenantId: preview.tenantId,
            entries: preview.entries,
            schedule: schedule.data,
            action: 'rate_copy',
            sourceTenantId: preview.pathTenantId,
            sourceVersionId: preview.sourceVersionId,
          });
        }
        return writeVersion(tx, {
          actor,
          tenantId: preview.tenantId,
          entries: preview.entries,
          schedule: schedule.data,
          action: 'rate_import',
        });
      });
      return response;
    } catch (error) {
      return conflict(error);
    }
  }
  async function exportRates({
    db,
    actor,
    tenantId,
    request,
  }: Mutation<AdminRateExportRequest>) {
    const input = adminRateExportRequestSchema.parse(request);
    return withAdmin(db, async (tx) => {
      const tenant = await readTenantCore(tx, tenantId);
      const version = await readVersion(tx, tenant.id, input.versionId);
      const auditId = randomUUID();
      await writeAudit(tx, {
        id: auditId,
        actor,
        occurredAt: (await databaseNow(tx)).toISOString(),
        tenantId: tenant.id,
        target: { kind: 'rate_version', id: version.id },
        action: 'rate_export',
        content: {
          summary: '导出费率',
          changes: [],
          rateVersionId: version.id,
        },
      });
      return {
        auditId,
        filename: `${tenant.code}-${version.id}.csv`,
        encoding: 'UTF-8' as const,
        contentType: 'text/csv' as const,
        csv: formatRateCsv(
          version.entries.map((entry) => ({
            prefix: entry.prefix,
            country: entry.country,
            iso: entry.iso,
            description: entry.description,
            perMinute: rate(tenant.currency, entry.rate),
          })),
        ),
      };
    });
  }
  async function cancelFutureVersion({
    db,
    actor,
    tenantId,
    request,
  }: Mutation<AdminRateCancelFutureVersionRequest>) {
    const input = adminRateCancelFutureVersionRequestSchema.parse(request);
    try {
      return await withAdmin(db, async (tx) => {
        await lockTenants(tx, [tenantId]);
        const tenant = await readTenantCore(tx, tenantId);
        const version = await readVersion(tx, tenant.id, input.versionId);
        const now = await databaseNow(tx);
        if (Date.parse(version.effectiveFrom) <= now.getTime() + margin * 1000)
          throw new AdminServiceError(
            'RATE_VERSION_CONFLICT',
            '费率已生效或临近生效',
          );
        const auditId = randomUUID();
        await writeAudit(tx, {
          id: auditId,
          actor,
          occurredAt: now.toISOString(),
          tenantId: tenant.id,
          target: { kind: 'rate_version', id: version.id },
          action: 'rate_schedule_cancel',
          content: {
            summary: '取消未来费率版本',
            changes: [],
            cancelledVersionId: version.id,
            entries: version.entries,
          },
        });
        await tx
          .delete(rateVersions)
          .where(
            and(
              eq(rateVersions.id, version.id),
              eq(rateVersions.tenantId, tenant.id),
            ),
          );
        return { auditId, cancelledVersionId: version.id };
      });
    } catch (error) {
      return conflict(error);
    }
  }
  return {
    getRates,
    editRate,
    importPreview,
    importCommit: (input: Mutation<AdminRateImportCommitRequest>) =>
      commit('import', input),
    copyPreview,
    copyCommit: (input: Mutation<AdminRateImportCommitRequest>) =>
      commit('copy', input),
    exportRates,
    cancelFutureVersion,
  };
}
