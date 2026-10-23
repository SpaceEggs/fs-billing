import { z } from 'zod';

// 仅提取人工定位所需的可信字段；时间校验失败时不猜测通话时间。
// uuid 只在语法合法时保留（与有效话单的 variables.uuid 同一规则），用于修正重推成功后对上旧的待处理行。
export const invalidCdrIdentitySchema = z
  .object({
    variables: z
      .object({
        billing_tenant: z.string().catch(''),
        caller_id_number: z.string().catch(''),
        destination_number: z.string().catch(''),
        billing_dialed_number: z.string().optional().catch(undefined),
        uuid: z
          .uuid()
          .transform((value) => value.toLowerCase())
          .optional()
          .catch(undefined),
      })
      .transform((v) => ({
        ...v,
        destination_number: v.billing_dialed_number ?? v.destination_number,
      }))
      .catch({
        billing_tenant: '',
        caller_id_number: '',
        destination_number: '',
        uuid: undefined,
      }),
  })
  .catch({
    variables: {
      billing_tenant: '',
      caller_id_number: '',
      destination_number: '',
      uuid: undefined,
    },
  });
