import {
  adminMailSettingsTestRequestSchema,
  adminMailSettingsUpdateRequestSchema,
} from '@fs-billing/shared';
import type { Db } from '@fs-billing/db';
import type { RouteHandlers } from './register.js';
import { mapBusinessErrors } from './business-errors.js';
import { adminActor } from './admin/tenants.js';
import {
  readMailSettings,
  testMailSettings,
  updateMailSettingsFromApi,
  type MailSettingsRuntime,
} from '../mail-settings.js';

/**
 * 邮箱设置：读取、保存、发送测试邮件。全部管理员操作，响应不含密码或密文。
 * SMTP 失败在测试接口里是 200 + `ok: false`，不是 5xx；只有请求/安全规则失败才用错误响应。
 */
export function mailSettingsHandlers(
  db: Db,
  runtime: MailSettingsRuntime,
): Pick<
  RouteHandlers,
  'adminMailSettings' | 'adminMailSettingsUpdate' | 'adminMailSettingsTest'
> {
  return {
    adminMailSettings: () => readMailSettings(db, runtime),
    adminMailSettingsUpdate: async (context, request) => {
      const body = adminMailSettingsUpdateRequestSchema.parse(request.body);
      return mapBusinessErrors(() =>
        updateMailSettingsFromApi(db, adminActor(context), runtime, body),
      );
    },
    adminMailSettingsTest: async (context, request) => {
      const body = adminMailSettingsTestRequestSchema.parse(request.body);
      return mapBusinessErrors(() =>
        testMailSettings(db, adminActor(context), runtime, body),
      );
    },
  };
}
