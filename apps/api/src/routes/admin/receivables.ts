import {
  confirmPayment,
  listReceivables,
  reversePayment,
  voidReceivable,
  type Db,
} from '@fs-billing/db';
import {
  adminConfirmPaymentRequestSchema,
  adminIdParamsSchema,
  adminReceivablesQuerySchema,
  adminReversePaymentRequestSchema,
  adminVoidReceivableRequestSchema,
} from '@fs-billing/shared';
import type { RouteHandlers } from '../register.js';
import { adminActor } from './tenants.js';

export function receivableHandlers(
  db: Db,
): Pick<
  RouteHandlers,
  | 'adminReceivables'
  | 'adminConfirmPayment'
  | 'adminReversePayment'
  | 'adminVoidReceivable'
> {
  return {
    adminReceivables: (_context, request) =>
      listReceivables({
        db,
        query: adminReceivablesQuerySchema.parse(request.query),
      }),
    adminConfirmPayment: (context, request) =>
      confirmPayment({
        db,
        actor: adminActor(context),
        ledgerEntryId: adminIdParamsSchema.parse(request.params).id,
        request: adminConfirmPaymentRequestSchema.parse(request.body),
      }),
    adminReversePayment: (context, request) =>
      reversePayment({
        db,
        actor: adminActor(context),
        ledgerEntryId: adminIdParamsSchema.parse(request.params).id,
        request: adminReversePaymentRequestSchema.parse(request.body),
      }),
    adminVoidReceivable: (context, request) =>
      voidReceivable({
        db,
        actor: adminActor(context),
        ledgerEntryId: adminIdParamsSchema.parse(request.params).id,
        request: adminVoidReceivableRequestSchema.parse(request.body),
      }),
  };
}
