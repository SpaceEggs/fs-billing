import { z } from 'zod';
import { LOCALES } from '../i18n/index.js';
import { identitySchema } from './identity.js';

export const loginRequestSchema = z.strictObject({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const newPasswordSchema = z.string().min(8).max(128);
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const sessionResponseSchema = z.strictObject({
  identity: identitySchema,
  expiresAt: z.iso.datetime(),
  passwordChangeRequired: z.boolean(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export const loginResponseSchema = sessionResponseSchema;
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const resetPasswordParamsSchema = z.strictObject({ id: z.uuid() });
export type ResetPasswordParams = z.infer<typeof resetPasswordParamsSchema>;

/** 只接受语言本身；目标账号永远取自会话身份的 profileId，请求里没有 id。 */
export const setLocaleRequestSchema = z.strictObject({
  locale: z.enum(LOCALES),
});
export type SetLocaleRequest = z.infer<typeof setLocaleRequestSchema>;
export const resetPasswordResponseSchema = z.strictObject({
  temporaryPassword: newPasswordSchema,
});
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;
