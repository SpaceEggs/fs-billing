import { randomUUID } from 'node:crypto';
import type { AuditActor, AuditChange } from '@fs-billing/shared';
import {
  readAlertSettings,
  saveAlertSettings,
  type AlertSettings,
} from '../alert-notify.js';
import { databaseNow } from '../clock.js';
import { withAdmin, type Db, type Tx } from '../client.js';
import { writeAudit } from './audit.js';

/** 告警设置的读（不含 `mailEnabled`：那是 API 配置，不在数据库里）。 */
export function getAlertSettings(db: Db | Tx): Promise<AlertSettings> {
  return withAdmin(db, (tx) => readAlertSettings(tx));
}

export interface UpdateAlertSettingsResult {
  readonly settings: AlertSettings;
  readonly auditId: string;
}

/**
 * 保存告警设置并写 `alert_settings_update` 操作日志（同一事务）。版本不符抛
 * `AlertSettingsVersionConflictError`（API 映射为 409 `ALERT_SETTINGS_VERSION_CONFLICT`），此时不写日志。
 * 内容没变也会保存（版本加一）并写日志，`changes` 为空：操作确实发生了，而且保存方拿到新版本才能继续改。
 */
export function updateAlertSettings(
  db: Db | Tx,
  input: {
    readonly actor: AuditActor;
    readonly recipients: readonly string[];
    readonly digestMinutes: number;
    readonly expectedVersion: number;
  },
): Promise<UpdateAlertSettingsResult> {
  return withAdmin(db, async (tx) => {
    const { before, after } = await saveAlertSettings(tx, {
      recipients: input.recipients,
      digestMinutes: input.digestMinutes,
      expectedVersion: input.expectedVersion,
      updatedBy: input.actor.id,
    });
    const changes: AuditChange[] = [];
    if (
      before.recipients.length !== after.recipients.length ||
      before.recipients.some(
        (address, index) => address !== after.recipients[index],
      )
    )
      changes.push({
        field: 'alertRecipients',
        before: [...before.recipients],
        after: [...after.recipients],
      });
    if (before.digestMinutes !== after.digestMinutes)
      changes.push({
        field: 'digestMinutes',
        before: String(before.digestMinutes),
        after: String(after.digestMinutes),
      });
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor: input.actor,
      occurredAt: (await databaseNow(tx)).toISOString(),
      tenantId: null,
      // 全局单行没有自己的 uuid：对象取本条审计自身的 id（同 unassigned_ignore）。
      target: { kind: 'alert_settings', id: auditId },
      action: 'alert_settings_update',
      content: {
        summary: '修改系统告警设置',
        changes,
        version: after.version,
      },
    });
    return { settings: after, auditId };
  });
}
