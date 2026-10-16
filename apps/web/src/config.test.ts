import { describe, expect, it } from 'vitest';
import { createWebConfig } from './config';

describe('web config', () => {
  it('defaults the large amount thresholds to CNY 10000 / USD 1500', () => {
    expect(createWebConfig({})).toEqual({
      largeAmountThresholds: { CNY: '10000', USD: '1500' },
    });
  });

  it('reads configured thresholds', () => {
    expect(
      createWebConfig({
        VITE_LARGE_AMOUNT_THRESHOLD_CNY: '20000.50',
        VITE_LARGE_AMOUNT_THRESHOLD_USD: '3000',
      }),
    ).toEqual({
      largeAmountThresholds: { CNY: '20000.50', USD: '3000' },
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
