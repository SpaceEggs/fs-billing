import { randomUUID } from 'node:crypto';
import type { AuditActor, AuditChange } from '@fs-billing/shared';
import {
  AlertSettingsVersionConflictError,
  normalizeAlertRecipients,
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
  /** 内容没变时不保存、不写日志，为 null。 */
  readonly auditId: string | null;
}

/**
 * 保存告警设置并写 `alert_settings_update` 操作日志（同一事务）。版本不符抛
 * `AlertSettingsVersionConflictError`（API 映射为 409 `ALERT_SETTINGS_VERSION_CONFLICT`），此时不写日志。
 * 内容没变（接收邮箱按集合比较，同 PR 4；汇总间隔相同）时什么也不做：不加版本、不写日志，返回当前设置和
 * `auditId: null`（同 `updateTenantSettings` 的先例）；`expectedVersion` 仍要匹配，否则照样是冲突。
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
    const current = await readAlertSettings(tx);
    if (current.version !== input.expectedVersion)
      throw new AlertSettingsVersionConflictError(current.version);
    const wanted = normalizeAlertRecipients(input.recipients);
    const known = new Set(current.recipients);
    if (
      input.digestMinutes === current.digestMinutes &&
      wanted.length === known.size &&
      wanted.every((address) => known.has(address))
    )
      return { settings: current, auditId: null };
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
