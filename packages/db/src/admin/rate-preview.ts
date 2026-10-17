import { z } from 'zod';
import {
  adminRateEntrySchema,
  adminRateScheduleShapeSchema,
} from '@fs-billing/shared';

export const ratePreviewPayloadSchema = z
  .object({
    actorId: z.uuid(),
    pathTenantId: z.uuid(),
    baseVersionId: z.uuid(),
    entries: z.array(adminRateEntrySchema),
    schedule: adminRateScheduleShapeSchema,
  })
  .and(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('import'),
        fileDigest: z.string().regex(/^[a-f0-9]{64}$/),
      }),
      z.object({ kind: z.literal('copy'), sourceVersionId: z.uuid() }),
    ]),
  );

export type RatePreviewPayload = z.infer<typeof ratePreviewPayloadSchema>;
