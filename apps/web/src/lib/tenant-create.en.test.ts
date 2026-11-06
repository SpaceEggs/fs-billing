import { describe, expect, it } from 'vitest';
import {
  addRecipients,
  buildSubmission,
  initialTenantForm,
  serverFieldErrors,
  type TenantForm,
} from './tenant-create';

const filled: TenantForm = {
  ...initialTenantForm('admin@example.com'),
  code: 'PCL022',
  name: 'Pacific Link Communications Ltd',
  lowBalanceThreshold: '200.00',
  portalEmail: 'billing@pacificlink.sg',
};

describe('tenant creation (English)', () => {
  it('adds recipients with English notices', () => {
    expect(addRecipients(['ops@a.cn'], 'OPS@a.cn', 'en')).toEqual({
      emails: ['ops@a.cn'],
      notice: '"ops@a.cn" is already in the list',
    });
    const twenty = Array.from({ length: 20 }, (_, index) => `u${index}@a.cn`);
    expect(addRecipients(twenty, 'extra@a.cn', 'en')).toEqual({
      emails: twenty,
      notice: 'At most 20 notification recipients',
    });
  });

  it('reports every invalid field in English', () => {
    expect(
      buildSubmission(
        {
          ...filled,
          code: 'ABC 01!',
          overdraftLimit: '-50',
          lowBalanceThreshold: '1.234',
          portalEmail: 'finance@abc',
          portalPassword: 'short',
          rates: { kind: 'csv', file: null },
        },
        'en',
      ),
    ).toEqual({
      ok: false,
      errors: {
        code: 'Only letters and digits are allowed; no spaces or symbols',
        overdraftLimit:
          'Overdraft limit cannot be negative. Enter 0 to disallow overdraft',
        lowBalanceThreshold:
          'Low balance threshold must be a number with at most 10 integer digits and 2 decimal places',
        portalEmail: 'Email format is invalid',
        portalPassword: 'The initial password must be 8 to 128 characters',
        rates: 'Choose a CSV file to import',
      },
    });
  });

  it('maps server issues through the English catalog keys', () => {
    expect(
      serverFieldErrors(
        [
          {
            path: ['code'],
            key: 'admin:tenant.create.codeRequired',
            message: '',
          },
          { path: ['unexpected'], message: 'Unknown field' },
        ],
        'en',
      ),
    ).toEqual({
      code: 'Enter the tenant code',
      form: 'Unknown field',
    });
  });
});
