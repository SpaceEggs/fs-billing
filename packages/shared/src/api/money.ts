import { z } from 'zod';
import { currencySchema } from './identity.js';

export const moneyAmountSchema = z
  .string()
  .max(128)
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
  .refine((amount) => !/^-0(?:\.0+)?$/.test(amount), {
    message: '金额不得为负零',
  });
export const moneySchema = z.strictObject({
  currency: currencySchema,
  amount: moneyAmountSchema,
});
export type Money = z.infer<typeof moneySchema>;
