import { describe, expect, it } from 'vitest';
import { ALERT_KIND_LABELS } from '../../mail/templates.js';
import {
  adminOverviewApiContract,
  adminSystemAlertApiContract,
} from './contract.js';
import { auditLabelActions, auditLabelOf } from './audit-logs.js';
import { auditPayloadSchema } from './audit.js';
import { adminApiErrorStatus } from './errors.js';
import { adminOverviewResponseSchema } from './overview.js';
import {
  adminAlertSettingsUpdateRequestSchema,
  adminSystemAlertsQuerySchema,
  alertKindLabel,
  alertKindSchema,
} from './system-alerts.js';

describe('phase 9 contract', () => {
  it('registers six admin-only operations; only the settings write is a PUT', () => {
    const contract = {
      ...adminOverviewApiContract,
      ...adminSystemAlertApiContract,
    };
    expect(Object.keys(contract).sort()).toEqual([
      'adminAlertSettings',
      'adminAlertSettingsUpdate',
      'adminOverview',
      'adminSystemAlertDetail',
      'adminSystemAlerts',
      'adminSystemAlertsSummary',
    ]);
    for (const operation of Object.values(contract)) {
      expect(operation.access).toBe('admin');
      expect(operation.isolationCase).toBe('admin-only');
    }
    expect(
      Object.values(contract)
        .filter((operation) => operation.method === 'PUT')
        .map((operation) => operation.operationId),
    ).toEqual(['adminAlertSettingsUpdate']);
    expect(
      adminSystemAlertApiContract.adminAlertSettingsUpdate.responses[409],
    ).toBeDefined();
    expect(adminApiErrorStatus.ALERT_SETTINGS_VERSION_CONFLICT).toBe(409);
  });

  it('labels every alert kind with the same text the mails use', () => {
    for (const kind of alertKindSchema.options) {
      expect(ALERT_KIND_LABELS[kind], kind).toBeTruthy();
      expect(alertKindLabel(kind)).toBe(ALERT_KIND_LABELS[kind]);
    }
  });

  it('defaults the list to all statuses over thirty days', () => {
    expect(adminSystemAlertsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 25,
      status: 'all',
      window: '30d',
    });
    for (const bad of [
      { window: '7d' },
      { status: 'closed' },
      { kind: 'other' },
      { tenantId: '11111111-1111-4111-8111-111111111111' },
    ])
      expect(adminSystemAlertsQuerySchema.safeParse(bad).success).toBe(false);
  });

  it('normalizes recipients like tenant emails and bounds the interval', () => {
    const parse = (body: object) =>
      adminAlertSettingsUpdateRequestSchema.safeParse({
        digestMinutes: 15,
        expectedVersion: 1,
        ...body,
      });
    expect(
      parse({
        recipients: ['A@Example.com', 'a@example.com', 'b@example.com'],
      }),
    ).toMatchObject({
      success: true,
      data: { recipients: ['a@example.com', 'b@example.com'] },
    });
    expect(parse({ recipients: [] }).success).toBe(true);
    const many = Array.from({ length: 20 }, (_, i) => `u${i}@example.com`);
    expect(parse({ recipients: many }).success).toBe(true);
    expect(parse({ recipients: [...many, 'u20@example.com'] }).success).toBe(
      false,
    );
    expect(parse({ recipients: ['x'] }).success).toBe(false);
    expect(parse({ recipients: [], digestMinutes: 0 }).success).toBe(false);
    expect(parse({ recipients: [], digestMinutes: 1441 }).success).toBe(false);
    expect(parse({ recipients: [], digestMinutes: 1440 }).success).toBe(true);
    expect(parse({ recipients: [], extra: 1 }).success).toBe(false);
  });

  it('records the settings change as an audit event under its own label', () => {
    expect(auditLabelOf('alert_settings_update')).toBe('settings');
    expect(auditLabelActions.settings).toEqual(['alert_settings_update']);
    const id = '11111111-1111-4111-8111-111111111111';
    const event = {
      id,
      actor: { id, name: '管理员' },
      occurredAt: '2026-10-29T04:00:00.000Z',
      tenantId: null,
      target: { kind: 'alert_settings', id },
      action: 'alert_settings_update',
      content: {
        summary: '修改系统告警设置',
        changes: [
          { field: 'alertRecipients', before: [], after: ['a@example.com'] },
          { field: 'digestMinutes', before: '15', after: '10' },
        ],
        version: 2,
      },
    };
    expect(auditPayloadSchema.safeParse(event).success).toBe(true);
    expect(
      auditPayloadSchema.safeParse({
        ...event,
        content: { ...event.content, version: 0 },
      }).success,
    ).toBe(false);
  });

  it('requires a thirty day series in the overview', () => {
    const money = { CNY: '0', USD: '0' };
    const days = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      ...money,
    }));
    const overview = {
      asOf: '2026-10-30T04:00:00.000Z',
      metrics: {
        tenantCount: 1,
        todayCallMinutes: '0',
        todayCallMinutesByCurrency: { CNY: '0', USD: '0' },
        suspendedTenantsByCurrency: { CNY: 0, USD: 0 },
        todaySpend: money,
        monthSpend: money,
        pendingReceivable: money,
        suspendedTenants: 0,
      },
      attention: {
        suspended: { total: 0, items: [] },
        lowBalance: { total: 0, items: [] },
        unassigned: { pending: 0, latestAt: null },
        alerts: { open: 0, last24h: 0, items: [] },
      },
      dailySpend: days,
    };
    expect(adminOverviewResponseSchema.safeParse(overview).success).toBe(true);
    expect(
      adminOverviewResponseSchema.safeParse({
        ...overview,
        dailySpend: days.slice(1),
      }).success,
    ).toBe(false);
  });
});
