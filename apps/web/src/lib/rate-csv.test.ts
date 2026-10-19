import { describe, expect, it } from 'vitest';
import { csvRawLine, decodeCsvLines } from './rate-csv';

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('decodeCsvLines', () => {
  it('numbers lines like the server: header is line 1, BOM dropped, CRLF and LF split', () => {
    const lines = decodeCsvLines(
      utf8('﻿ISO,国家,号码前缀,说明,费率\r\n,中国,86,,0.05\n\n,美国,1,,-1\r\n'),
    );
    expect(csvRawLine(lines, 1)).toBe('ISO,国家,号码前缀,说明,费率');
    expect(csvRawLine(lines, 2)).toBe(',中国,86,,0.05');
    expect(csvRawLine(lines, 3)).toBe('—');
    expect(csvRawLine(lines, 4)).toBe(',美国,1,,-1');
    expect(csvRawLine(lines, 6)).toBe('—');
    expect(csvRawLine(lines, 99)).toBe('—');
  });

  it('falls back to GBK when the bytes are not UTF-8', () => {
    // 「86,中国,0.05」的 GBK 字节：中 D6D0、国 B9FA。
    const gbk = new Uint8Array([
      0x70, 0x2c, 0x63, 0x2c, 0x72, 0x0d, 0x0a, 0x38, 0x36, 0x2c, 0xd6, 0xd0,
      0xb9, 0xfa, 0x2c, 0x30, 0x2e, 0x30, 0x35,
    ]);
    const lines = decodeCsvLines(gbk);
    expect(csvRawLine(lines, 1)).toBe('p,c,r');
    expect(csvRawLine(lines, 2)).toBe('86,中国,0.05');
  });

  it('shows — for every line when neither encoding decodes, never replacement characters', () => {
    const lines = decodeCsvLines(
      new Uint8Array([0x38, 0x36, 0x2c, 0xff, 0xff]),
    );
    expect(lines).toBeNull();
    expect(csvRawLine(lines, 1)).toBe('—');
  });
});
