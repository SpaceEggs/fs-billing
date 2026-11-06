import type { Locale } from '@fs-billing/shared';
import { sql } from 'drizzle-orm';
import { withAdmin, type Db } from './client.js';

/**
 * 账号语言的目标。`profileId`、`authUserId`、`tenantId` 必须来自会话身份，
 * 不能取请求参数；WHERE 同时校验三者，A 的会话改不到 B 的行。
 */
export interface AccountLocaleTarget {
  kind: 'admin' | 'customer';
  profileId: string;
  authUserId: string;
  /** 客户账号的租户；管理员没有租户，可为空。 */
  tenantId?: string | null;
}

/**
 * 写入账号语言（docs/i18n-design.md §6.1）。租户身份没有写权，所以和 last_login_at
 * 一样由 API 用 `withAdmin` 写。返回是否命中本人那一行。
 */
export async function setAccountLocale(
  db: Db,
  target: AccountLocaleTarget,
  locale: Locale,
): Promise<boolean> {
  return withAdmin(db, async (tx) => {
    const result = await tx.execute(
      target.kind === 'admin'
        ? sql`update admins set locale = ${locale}
              where id = ${target.profileId} and auth_user_id = ${target.authUserId}
              returning id`
        : sql`update portal_accounts set locale = ${locale}
              where id = ${target.profileId} and auth_user_id = ${target.authUserId}
                and tenant_id = ${target.tenantId}
              returning id`,
    );
    return result.rows.length === 1;
  });
}
