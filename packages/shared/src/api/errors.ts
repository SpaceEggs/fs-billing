import { z } from 'zod';

const errorFields = {
  message: z.string().min(1),
  requestId: z.string().min(1),
};
const reauthenticationFields = {
  action: z.literal('reauthenticate'),
};
const retryFields = {
  retryAfterSeconds: z.number().int().positive(),
};
export const validationIssueSchema = z.strictObject({
  path: z.array(z.union([z.string(), z.number()])),
  message: z.string().min(1),
});
export type ValidationIssue = z.infer<typeof validationIssueSchema>;

function defineError<
  const Code extends string,
  const Status extends number,
  Fields extends z.ZodRawShape,
>(code: Code, status: Status, fields: Fields) {
  const detail = z.strictObject({
    ...errorFields,
    ...fields,
    code: z.literal(code),
  });
  return { code, status, detail, response: z.strictObject({ error: detail }) };
}

const errorDefinitions = [
  defineError('UNAUTHENTICATED', 401, reauthenticationFields),
  defineError('SESSION_EXPIRED', 401, reauthenticationFields),
  defineError('INVALID_CREDENTIALS', 401, {}),
  defineError('FORBIDDEN', 403, {}),
  defineError('ACCOUNT_DISABLED', 403, {}),
  defineError('IDENTITY_UNAVAILABLE', 403, {}),
  defineError('ACCOUNT_LOCKED', 429, retryFields),
  defineError('VALIDATION_ERROR', 400, {
    issues: z.array(validationIssueSchema).min(1),
  }),
  defineError('NOT_FOUND', 404, {}),
  defineError('RATE_LIMITED', 429, retryFields),
  defineError('SERVICE_UNAVAILABLE', 503, {}),
  defineError('INTERNAL_ERROR', 500, {}),
] as const;

export const apiErrorSchema = z.strictObject({
  error: z.discriminatedUnion('code', [
    errorDefinitions[0].detail,
    ...errorDefinitions.slice(1).map(({ detail }) => detail),
  ]),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

type ErrorDefinition = (typeof errorDefinitions)[number];
type ErrorIndex<Field extends 'response' | 'status'> = {
  [Definition in ErrorDefinition as Definition['code']]: Definition[Field];
};

function indexErrors<Field extends 'response' | 'status'>(field: Field) {
  // Object.fromEntries loses the correspondence between literal keys and values.
  return Object.fromEntries(
    errorDefinitions.map((definition) => [definition.code, definition[field]]),
  ) as ErrorIndex<Field>;
}

export const apiErrorSchemas = indexErrors('response');
export const apiErrorStatus = indexErrors('status');
