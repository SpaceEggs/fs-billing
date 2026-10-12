import { z } from 'zod';

// Drizzle 表结构、迁移、非超级用户连接与 RLS 在阶段 2 实现。
export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.url().refine((value) => /^postgres(?:ql)?:/.test(value), {
    message: 'DATABASE_URL 必须使用 PostgreSQL 协议',
  }),
});
