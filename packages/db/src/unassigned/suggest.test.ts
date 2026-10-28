import { describe, expect, it } from 'vitest';
import { withinOneEdit } from './suggest.js';

describe('withinOneEdit', () => {
  it.each([
    ['ABC01', 'ABC001'],
    ['abc001', 'ABC001'],
    ['ABC001', 'ABC001'],
    ['ABC002', 'ABC001'],
    ['BC001', 'ABC001'],
    ['ABC001X', 'ABC001'],
    ['XABC001', 'ABC001'],
    ['', 'A'],
  ])('accepts %s against %s', (a, b) => {
    expect(withinOneEdit(a, b)).toBe(true);
    expect(withinOneEdit(b, a)).toBe(true);
  });

  it.each([
    ['ABC', 'ABC001'],
    ['AXC002', 'ABC001'],
    ['ACB001', 'ABC001'],
    ['TEST', 'ABC001'],
    ['', 'AB'],
  ])('rejects %s against %s', (a, b) => {
    expect(withinOneEdit(a, b)).toBe(false);
    expect(withinOneEdit(b, a)).toBe(false);
  });
});
