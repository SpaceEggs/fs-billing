import { describe, expect, it } from 'vitest';
import { createWebConfig } from './config';

describe('web config', () => {
  it('defaults the large amount thresholds to CNY 10000 / USD 1500 and keeps the overview off', () => {
    expect(createWebConfig({})).toEqual({
      largeAmountThresholds: { CNY: '10000', USD: '1500' },
      tenantOverviewEnabled: false,
    });
  });

  it('reads configured thresholds and the overview flag', () => {
    expect(
      createWebConfig({
        VITE_LARGE_AMOUNT_THRESHOLD_CNY: '20000.50',
        VITE_LARGE_AMOUNT_THRESHOLD_USD: '3000',
        VITE_TENANT_OVERVIEW: 'on',
      }),
    ).toEqual({
      largeAmountThresholds: { CNY: '20000.50', USD: '3000' },
      tenantOverviewEnabled: true,
    });
  });

  it('fails instead of silently ignoring a malformed threshold', () => {
    expect(() =>
      createWebConfig({ VITE_LARGE_AMOUNT_THRESHOLD_CNY: '1e4' }),
    ).toThrow();
    expect(() =>
      createWebConfig({ VITE_LARGE_AMOUNT_THRESHOLD_USD: '-1' }),
    ).toThrow();
  });
});
