import { z } from 'zod';
import { moneyAmountSchema } from '../money.js';
import { currencySchema, tenantIdentitySchema } from '../identity.js';
import {
  adminAuditedMutationResponseSchema,
  adminInputAmountSchemas,
  adminNonnegativeAmountSchema,
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminStatusSchema,
  adminTimestampSchema,
} from './common.js';
import { adminRateEntriesSchema, adminCsvFileSchema } from './rates.js';

export const adminTenantHealthSchema = z.enum([
  'suspended',
  'overdraft',
  'low_balance',
  'normal',
  'disabled',
]);
export const adminTenantSettingsRequestSchema = z.strictObject({
  overdraftLimit: adminInputAmountSchemas.settings,
  lowBalanceThreshold: adminInputAmountSchemas.settings,
  emails: z
    .array(z.email())
    .max(100)
    .transform((emails) => [
      ...new Set(emails.map((email) => email.toLowerCase())),
    ])
    .pipe(z.array(z.email()).max(20)),
});
export const adminTenantSettingsResponseSchema = z.strictObject({
  overdraftLimit: adminNonnegativeAmountSchema,
  lowBalanceThreshold: moneyAmountSchema,
  emails: z.array(z.email()),
});
const contactFields = {
  contactName: z.string().max(200).default(''),
  contactPhone: z.string().max(100).default(''),
  remark: z.string().max(2000).default(''),
};
export const adminTenantEditRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  contactName: contactFields.contactName.removeDefault(),
  contactPhone: contactFields.contactPhone.removeDefault(),
  remark: contactFields.remark.removeDefault(),
});
export const adminTenantInitialRatesSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('blank') }),
  z.strictObject({
    kind: z.literal('entries'),
    entries: adminRateEntriesSchema,
  }),
  z.strictObject({
    kind: z.literal('copy'),
    sourceTenantId: z.uuid(),
    sourceVersionId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('csv'), file: adminCsvFileSchema }),
]);
export const adminTenantCreateRequestSchema =
  adminTenantEditRequestSchema.extend({
    ...contactFields,
    code: z
      .string()
      .regex(/^[A-Za-z0-9]+$/)
      .max(64)
      .transform((code) => code.toUpperCase()),
    currency: currencySchema,
    settings: adminTenantSettingsRequestSchema
      .omit({ overdraftLimit: true })
      .extend({
        overdraftLimit: adminInputAmountSchemas.settings.optional(),
        emails: adminTenantSettingsRequestSchema.shape.emails.optional(),
      }),
    initialRates: adminTenantInitialRatesSchema,
  });
export const adminTenantSummarySchema = tenantIdentitySchema.extend({
  status: adminStatusSchema,
  health: adminTenantHealthSchema,
  settingsConfigured: z.boolean(),
  balance: moneyAmountSchema,
  overdraftLimit: adminNonnegativeAmountSchema,
  availableBalance: moneyAmountSchema,
  monthConsumption: adminNonnegativeAmountSchema,
  pendingReceivable: adminNonnegativeAmountSchema,
});
export const adminTenantsQuerySchema = adminPageQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: adminTenantHealthSchema.optional(),
  currency: currencySchema.optional(),
  sort: z.literal('status_currency_balance').default('status_currency_balance'),
});
export const adminTenantsResponseSchema = z.strictObject({
  items: z.array(adminTenantSummarySchema),
  pagination: adminPageInfoSchema,
});
export const adminTenantDetailResponseSchema = adminTenantSummarySchema.extend({
  ...contactFields,
  settings: adminTenantSettingsResponseSchema,
  createdAt: adminTimestampSchema,
});
export const adminTenantCreateResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    tenant: adminTenantDetailResponseSchema,
    initialRateVersionId: z.uuid(),
    effectiveFrom: adminTimestampSchema,
  });
export const adminTenantOverviewResponseSchema = z.strictObject({
  currency: currencySchema,
  monthConsumption: adminNonnegativeAmountSchema,
  monthCallMinutes: z.string().regex(/^\d+(?:\.\d+)?$/),
  dailyConsumption: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        amount: adminNonnegativeAmountSchema,
      }),
    )
    .max(30),
});

export type AdminTenantHealth = z.infer<typeof adminTenantHealthSchema>;
export type AdminTenantSettingsRequest = z.infer<
  typeof adminTenantSettingsRequestSchema
>;
export type AdminTenantSettingsResponse = z.infer<
  typeof adminTenantSettingsResponseSchema
>;
export type AdminTenantEditRequest = z.infer<
  typeof adminTenantEditRequestSchema
>;
export type AdminTenantInitialRates = z.infer<
  typeof adminTenantInitialRatesSchema
>;
export type AdminTenantCreateRequest = z.infer<
  typeof adminTenantCreateRequestSchema
>;
export type AdminTenantSummary = z.infer<typeof adminTenantSummarySchema>;
export type AdminTenantsQuery = z.infer<typeof adminTenantsQuerySchema>;
export type AdminTenantsResponse = z.infer<typeof adminTenantsResponseSchema>;
export type AdminTenantDetailResponse = z.infer<
  typeof adminTenantDetailResponseSchema
>;
export type AdminTenantCreateResponse = z.infer<
  typeof adminTenantCreateResponseSchema
>;
export type AdminTenantOverviewResponse = z.infer<
  typeof adminTenantOverviewResponseSchema
>;

export const adminTenantCopyConsistencySchema =
  adminTenantInitialRatesSchema.options[2]
    .extend({
      targetCurrency: currencySchema,
      sourceVersion: z.strictObject({
        id: z.uuid(),
        tenantId: z.uuid(),
        currency: currencySchema,
      }),
    })
    .refine(
      (copy) =>
        copy.sourceVersion.id === copy.sourceVersionId &&
        copy.sourceVersion.tenantId === copy.sourceTenantId,
      {
        message: '来源版本必须属于来源租户',
        path: ['sourceVersionId'],
      },
    )
    .refine((copy) => copy.sourceVersion.currency === copy.targetCurrency, {
      message: '来源与目标币种必须一致',
      path: ['targetCurrency'],
    });
