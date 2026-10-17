import { expect, it } from 'vitest';
import { contentDisposition, exportFilename } from './export.js';

it('names exports after the tenant code and the Beijing day range', () => {
  expect(
    exportFilename('cdrs', 'ABC001', { from: '2026-09-01', to: '2026-09-29' }),
  ).toBe('cdrs_ABC001_2026-09-01_2026-09-29.csv');
  expect(
    exportFilename('ledger', 'XYZ002', {
      from: '2026-09-28',
      to: '2026-09-28',
    }),
  ).toBe('ledger_XYZ002_2026-09-28_2026-09-28.csv');
});

it('asks the browser to save the response as an attachment', () => {
  expect(contentDisposition('cdrs_ABC001_2026-09-01_2026-09-29.csv')).toBe(
    'attachment; filename="cdrs_ABC001_2026-09-01_2026-09-29.csv"',
  );
});
