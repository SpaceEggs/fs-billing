import { auditPayloadSchema, type AuditPayload } from '@fs-billing/shared';
import type { Tx } from '../client.js';
import { operationLogs } from '../schema.js';

export async function writeAudit(tx: Tx, event: AuditPayload): Promise<void> {
  const payload = auditPayloadSchema.parse(event);
  await tx.insert(operationLogs).values({
    id: payload.id,
    adminId: payload.actor.id,
    tenantId: payload.tenantId,
    action: payload.action,
    target: payload.target.id,
    details: {
      actor: payload.actor,
      target: payload.target,
      content: payload.content,
    },
    createdAt: new Date(payload.occurredAt),
  });
}
