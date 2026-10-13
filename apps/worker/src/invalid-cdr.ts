import { z } from 'zod';

// 仅提取人工定位所需的可信字段；时间校验失败时不猜测通话时间。
export const invalidCdrIdentitySchema = z
  .object({
    variables: z
      .object({
        uuid: z
          .uuid()
          .transform((value) => value.toLowerCase())
          .nullable()
          .catch(null),
        billing_tenant: z.string().catch(''),
        caller_id_number: z.string().catch(''),
        destination_number: z.string().catch(''),
      })
      .catch({
        uuid: null,
        billing_tenant: '',
        caller_id_number: '',
        destination_number: '',
      }),
  })
  .catch({
    variables: {
      uuid: null,
      billing_tenant: '',
      caller_id_number: '',
      destination_number: '',
    },
  });
