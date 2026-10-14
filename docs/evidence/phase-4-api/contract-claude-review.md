No blocking issues. The contract can ship once the first two SHOULD-FIX items are settled.

I checked the staged index against `/tmp/p/contract.diff` and they are identical. `pnpm -C packages/shared typecheck` passes with no errors, and `vitest run packages/shared` passes 34/34 tests. Nothing was edited.

## Decision conformance

| Decision                                                                         | Status                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| No `authUserId` in browser identity                                              | ✅ `identity.ts:14-28` uses strict objects, and a test rejects the extra key (`api.test.ts:43-48`) |
| `UNAUTHENTICATED` / `SESSION_EXPIRED` return 401 with `action: 'reauthenticate'` | ✅ `errors.ts:7-25`. `INVALID_CREDENTIALS` cannot carry `action` (`api.test.ts:218-226`)           |
| `FORBIDDEN`, `INVALID_CREDENTIALS`, `ACCOUNT_DISABLED`, `IDENTITY_UNAVAILABLE`   | ✅                                                                                                 |
| `ACCOUNT_LOCKED` 429 with integer `retryAfterSeconds` > 0                        | ✅ Returned by login and change-password, not by other routes                                      |
| Separate admin reset routes per profile table                                    | ✅ `contract.ts:172-181`. The request has no role or authUserId                                    |
| Money is never a float                                                           | ✅ Decimal string only. A JS number, exponent, leading `+` or whitespace are all rejected          |

## BLOCKING

None.

## SHOULD-FIX

1. **`contract.ts:115`: a disabled user can't log out.** Logout uses the same error set as other protected routes, including 403 `ACCOUNT_DISABLED` / `IDENTITY_UNAVAILABLE`, so the API presumably resolves the user's profile before logging out. If an account is disabled mid-session, every request returns 403. 403 doesn't send the user to login (doc :43), and logout also returns 403, so the session cookie is never cleared and the user is stuck. Logout should need only a valid Better Auth session and skip profile resolution. Remove the 403 entry from its responses and state this in doc §3. The same question applies to `session`: decide whether a disabled user gets 403 or 401 with `reauthenticate`, and write down what the frontend does in each case.
2. **Doc :328: Better Auth's per-IP rate limit probably doesn't apply to our login.** As far as I know, its limiter runs only on requests that arrive through Better Auth's own HTTP router. Our handler calls `auth.api.signInEmail` directly from server code, which likely skips it. The doc already requires a test for this. Plan now for a Fastify-level limiter (for example `@fastify/rate-limit`) that returns `RATE_LIMITED` with `retryAfterSeconds`. Otherwise that test fails in step 3 and the 429 contract has nothing behind it.
3. **`contract.ts:177` / doc §11.3: an admin can reset their own password.** That reset deletes all their own sessions, including the current one. They get 200 with the temporary password, then 401 on the next request. Either forbid self-reset (403, or `VALIDATION_ERROR`) or document the flow, so phase 5's UI doesn't treat it as a session-expiry bug.
4. **`contract.ts:42`: POSTs with no body are easy for the frontend to get wrong.** These are logout, revoke-other-sessions and both resets, and their body schema is `z.undefined()`. Common fetch wrappers send `Content-Type: application/json` with `{}`, or an empty body. Fastify rejects an empty JSON body with a 400 error of its own (`FST_ERR_CTP_EMPTY_JSON_BODY`), and `{}` fails the schema. Either state in §3 that these routes take no body and no `Content-Type`, or accept `z.strictObject({}).optional()`.

## NIT

- **`contract.ts:103`:** login's 403 includes `FORBIDDEN`, but no login path produces it. Remove it so frontend error handling doesn't need a dead branch.
- **`contract.ts:31` with `api.test.ts:346-354`:** the test requires `audience` to be exactly what `access` implies, so the field adds no information. Derive it from `access`, or drop it.
- **`errors.ts:17-103`:** every code is listed three times (the details map, the union, and `apiErrorSchemas`), and a fourth time in `apiErrorStatus`. Build the union and the wrappers from `Object.values(errorDetails)` so adding a code is a one-line change.
- **`errors.ts:12`:** `path: z.array(z.string())`, but Zod issue paths can contain array indexes, which are numbers. The server adapter must convert them to strings, or the schema should allow `string | number`.
- **`money.ts:6`:**
  - `(?![\s\S])` does the same job as `$` here, because in JS `$` without the `m` flag doesn't match before a trailing `\n`. Use `$`.
  - `-0` and `-0.00` are accepted. Postgres numeric never outputs these, so the impact is cosmetic.
  - There's no length limit on the amount string.
- **`auth.ts:17` and the identity schemas:** the response schemas are strict. If the web app parses responses with them, adding a field on the server breaks any SPA bundle the browser already loaded until it reloads. Use strict parsing in tests and server serialization, and tolerant parsing in the browser, or say that the API and web always deploy together.
- **`contract.ts:137`:** change-password returns 204, but Better Auth issues a new session, so the frontend's cached `expiresAt` goes stale. Either return `sessionResponseSchema`, or have the frontend call `session` again afterwards.
- **`health.ts:3`:** still `z.object` rather than strict. This is how it was before, but it's inconsistent with the new contract.
- **Doc:**
  - **:28:** the login example omits `email`, which the schema requires.
  - **:79:** the sketch names the type `RouteAudience`, but the code has `ApiAudience`.
  - **:3:** "只编辑文件，不提交、不推送" is a process note that goes stale once this is committed.
  - **:186-190:** the review-history and principle-name paragraphs are noise in a final design doc.
- **Tests:** they check real behaviour: they parse literal values and check the exact result. Missing cases: `-0`, and a protected route returning `ACCOUNT_DISABLED` (and logout, once item 1 is decided).

## Verdict

**Approve with changes.** The contract matches every adopted decision, money handling is safe, the schemas are strict, and the tests check real behaviour. Fix SHOULD-FIX 1 (logout / disabled session) and 4 (bodyless POSTs) before the frontend starts building against the contract. Items 2 and 3 can be settled in the doc during API step 3.

---

## Re-review

# Re-review of `/tmp/p/contract2.diff`

**Verdict: approve.** Every prior BLOCKING and SHOULD-FIX item is resolved. There is one new minor SHOULD-FIX (logout's `access` value) and a few leftover NITs.

The staged index is byte-identical to `contract2.diff`. `pnpm -C packages/shared typecheck` passes, and `vitest run packages/shared` passes 46/46 (up from 34). Nothing was edited.

## Prior findings

| #   | Finding                                                 | Status                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SF1 | Logout blocked for a disabled user                      | ✅ Logout's responses no longer include 403 (`contract.ts:102-114`). Doc :106 says logout only checks the Better Auth session and skips profile resolution. It also settles `session` (403 `ACCOUNT_DISABLED`) and says what the frontend does: show a disabled page with a logout button. Tested at `api.test.ts:444`, and doc :290 adds a DB test. |
| SF2 | Better Auth's IP limiter is bypassed                    | ✅ The doc adopts `@fastify/rate-limit@10.3.0` in front of the server API calls, with a custom 429 `RATE_LIMITED` plus `Retry-After` (doc :309, :330-332, :292).                                                                                                                                                                                     |
| SF3 | Admin can reset their own password                      | ✅ Self-reset returns 403 `FORBIDDEN` and points to change-password (doc :142, :297). The reset routes keep 403 `FORBIDDEN` (`api.test.ts:459`).                                                                                                                                                                                                     |
| SF4 | POSTs with no body                                      | ✅ The body is `z.strictObject({}).optional()` (`contract.ts:40`). Doc :102 says to omit `Content-Type` when sending no body. Tested at `api.test.ts:421`, and doc :291 adds a real HTTP test.                                                                                                                                                       |
| NIT | `FORBIDDEN` listed on login                             | ✅ Removed (`contract.ts:98`)                                                                                                                                                                                                                                                                                                                        |
| NIT | Redundant `audience` field                              | ✅ Dropped. It is now derived from `access`, which gains an `authenticated` value.                                                                                                                                                                                                                                                                   |
| NIT | Each error code listed 3–4 times                        | ✅ One `defineError` table now generates the union, the response schemas and the status map (`errors.ts:32-71`).                                                                                                                                                                                                                                     |
| NIT | Issue `path` only allowed strings                       | ✅ Now `string \| number`                                                                                                                                                                                                                                                                                                                            |
| NIT | Money regex                                             | ✅ Uses `$`, rejects `-0`/`-0.00`, and has `max(128)`. Tested at `api.test.ts:126-133`.                                                                                                                                                                                                                                                              |
| NIT | Strict response schemas in the browser                  | ✅ Doc :104 says the API and web always deploy together, and old bundles must reload.                                                                                                                                                                                                                                                                |
| NIT | Change-password returned 204                            | ✅ Now returns 200 `sessionResponseSchema` (`contract.ts:133`, test :436)                                                                                                                                                                                                                                                                            |
| NIT | `health.ts` not strict                                  | ✅ Now `z.strictObject` (test :485)                                                                                                                                                                                                                                                                                                                  |
| NIT | Doc :28, :79, :3                                        | ✅ The login example has `email`, the `RouteAudience` sketch is gone, and the process note is removed.                                                                                                                                                                                                                                               |
| NIT | Doc review-history paragraphs                           | ⚠️ Partly fixed. Doc :189 ("比较时重点核对…") still reads as review history. Cosmetic.                                                                                                                                                                                                                                                               |
| NIT | Missing tests: `-0`, protected-route `ACCOUNT_DISABLED` | ✅ Both added                                                                                                                                                                                                                                                                                                                                        |

## New findings

**BLOCKING:** none.

**SHOULD-FIX (minor):**

- **`contract.ts:106` vs doc :102 / :106: logout shares `access: 'authenticated'` with routes that do resolve the profile.**
  - The doc says `authenticated` maps to customer and admin. Knowing which one means resolving the profile.
  - Doc :106 says logout must not resolve the profile.
  - If the step-3 registry sets each route's guard from `access`, as design option A implies, logout gets profile resolution and 403s again. That brings SF1 back.
  - Fix: give logout its own access value (e.g. `'session'`, meaning a session is enough), or add an explicit `resolveIdentity: false` flag. Then the registry can enforce it and a test can check it.

**NIT:**

- **`money.ts:8`:** the regex already excludes whitespace, and `$` only matches at the true end of the string, so the `!/\s/` check in the refine never fires. Keep only the negative-zero check and drop "空白" from the message.
- **`contract.ts:42-47`:** `commonErrors` puts 429 `RATE_LIMITED` on `health`, but nothing rate-limits health. This was already there in the first round.
