import {
  alertsInWindow,
  getAlertDetail,
  getAlertSettings,
  readAlertSummary,
  updateAlertSettings,
  type Db,
} from '@fs-billing/db';
import {
  adminAlertIdParamsSchema,
  adminAlertSettingsUpdateRequestSchema,
  adminSystemAlertsQuerySchema,
} from '@fs-billing/shared';
import type { RouteHandlers } from './register.js';
import { mapBusinessErrors } from './business-errors.js';
import { adminActor } from './admin/tenants.js';

/**
 * 系统告警与告警设置（阶段 9）。全部是后台操作（`access: 'admin'`）；设置里的 `mailEnabled` 取自 API 配置，
 * 不含凭据。写设置带 `expectedVersion`，版本不符经 `mapBusinessErrors` 变成 409。
 */
export function systemAlertHandlers(
  db: Db,
  options: { mailEnabled: boolean },
): Pick<
  RouteHandlers,
  | 'adminSystemAlertsSummary'
  | 'adminSystemAlerts'
  | 'adminSystemAlertDetail'
  | 'adminAlertSettings'
  | 'adminAlertSettingsUpdate'
> {
  const settingsBody = (settings: {
    recipients: readonly string[];
    digestMinutes: number;
    version: number;
  }) => ({
    recipients: [...settings.recipients],
    digestMinutes: settings.digestMinutes,
    version: settings.version,
    mailEnabled: options.mailEnabled,
  });
  return {
    adminSystemAlertsSummary: () => readAlertSummary(db),
    adminSystemAlerts: async (_context, request) => {
      const query = adminSystemAlertsQuerySchema.parse(request.query);
      const list = await alertsInWindow(db, query);
      return {
        items: [...list.items],
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: list.total,
        },
        openCount: list.openCount,
      };
    },
    adminSystemAlertDetail: (_context, request) =>
      getAlertDetail(
        db,
        adminAlertIdParamsSchema.parse(request.params).alertId,
      ),
    adminAlertSettings: async () => settingsBody(await getAlertSettings(db)),
    adminAlertSettingsUpdate: async (context, request) => {
      const body = adminAlertSettingsUpdateRequestSchema.parse(request.body);
      const result = await mapBusinessErrors(() =>
        updateAlertSettings(db, { ...body, actor: adminActor(context) }),
      );
      return { ...settingsBody(result.settings), auditId: result.auditId };
    },
  };
}
