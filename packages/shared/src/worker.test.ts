import { describe, expect, it } from 'vitest';
import {
  CDR_REASON_MAX_LENGTH,
  CDR_VALIDATION_FAILURE_PREFIX,
  modJsonCdrSchema,
  summarizeCdrIssues,
} from './worker.js';

const valid = {
  variables: {
    uuid: '6f1c3c2a-4a4f-4d5e-9f43-3a5f6b0d1f01',
    billing_tenant: 'ABC001',
    start_epoch: '1760000000',
    answer_epoch: '1760000005',
    end_epoch: '1760000066',
    billsec: '61',
    duration: '66',
    billing_dialed_number: '447700900123',
  },
};

function failure(input: unknown) {
  const parsed = modJsonCdrSchema.safeParse(input);
  if (parsed.success) throw new Error('期望校验失败');
  return parsed.error;
}

describe('summarizeCdrIssues', () => {
  it('lists the failing paths with their error codes behind the fixed prefix', () => {
    const reason = summarizeCdrIssues(
      failure({
        variables: { ...valid.variables, billsec: 'abc', uuid: 'broken' },
      }),
    );
    expect(reason).toBe(
      `${CDR_VALIDATION_FAILURE_PREFIX}variables.uuid(invalid_format), variables.billsec(invalid_format)`,
    );
  });

  it('summarizes issues to at most five paths', () => {
    const error = failure({ variables: {} });
    expect(error.issues.length).toBeGreaterThan(5);
    const reason = summarizeCdrIssues(error);
    const listed = reason
      .slice(CDR_VALIDATION_FAILURE_PREFIX.length)
      .replace(/ 等 \d+ 项$/, '')
      .split(', ');
    expect(listed).toHaveLength(5);
    expect(reason).toMatch(new RegExp(` 等 ${error.issues.length} 项$`));
  });

  it('does not add the tail when everything fits', () => {
    expect(summarizeCdrIssues(failure(null))).toBe(
      `${CDR_VALIDATION_FAILURE_PREFIX}(root)(invalid_type)`,
    );
  });

  it('names a cross-field inconsistency without a message or input values', () => {
    const reason = summarizeCdrIssues(
      failure({ variables: { ...valid.variables, duration: '1' } }),
    );
    expect(reason).toBe(`${CDR_VALIDATION_FAILURE_PREFIX}(root)(custom)`);
    expect(reason).not.toContain('话单时间与时长不一致');
  });

  it('never exceeds the length limit and never carries input values or Zod messages', () => {
    const secret = 'SECRET-VALUE-DO-NOT-LOG';
    for (const input of [
      { variables: { ...valid.variables, billsec: secret } },
      { variables: { uuid: secret } },
      { variables: {}, callflow: [secret] },
      secret,
    ]) {
      const reason = summarizeCdrIssues(failure(input));
      expect(reason.length).toBeLessThanOrEqual(CDR_REASON_MAX_LENGTH);
      expect(reason.startsWith(CDR_VALIDATION_FAILURE_PREFIX)).toBe(true);
      expect(reason).not.toContain(secret);
      expect(reason).not.toContain('Invalid');
      expect(reason).not.toContain('"');
    }
  });

  it('truncates a very long list of paths to the limit', () => {
    const reason = summarizeCdrIssues({
      issues: Array.from({ length: 9 }, (_, index) => ({
        code: 'invalid_type',
        path: ['variables', 'x'.repeat(60) + index],
      })),
    });
    expect(reason.length).toBeLessThanOrEqual(CDR_REASON_MAX_LENGTH);
    expect(reason.endsWith(' 等 9 项')).toBe(true);
  });

  it('counts one path and code once', () => {
    expect(
      summarizeCdrIssues({
        issues: [
          { code: 'invalid_type', path: ['variables', 'uuid'] },
          { code: 'invalid_type', path: ['variables', 'uuid'] },
        ],
      }),
    ).toBe(`${CDR_VALIDATION_FAILURE_PREFIX}variables.uuid(invalid_type)`);
  });
});
