import { auditPayloadSchema, type AuditPayload } from '@fs-billing/shared';
import type { Tx } from '../client.js';
import { operationLogs } from '../schema.js';

export async function writeAudit(tx: Tx, event: AuditPayload): Promise<void> {
  const payload = auditPayloadSchema.parse(event);
  // 管理员操作记 admin_id；没有管理员的事件（actor 是 { label }）记 actor_label，二者恰有其一。
  const actor =
    'id' in payload.actor
      ? { adminId: payload.actor.id, actorLabel: null }
      : { adminId: null, actorLabel: payload.actor.label };
  await tx.insert(operationLogs).values({
    id: payload.id,
    ...actor,
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
