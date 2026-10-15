import { z } from 'zod';
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
export const resetPasswordResponseSchema = z.strictObject({
  temporaryPassword: newPasswordSchema,
});
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;
