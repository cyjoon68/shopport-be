import { BadRequestException } from '@nestjs/common';

import { decodeCursor, decodePageCursor, encodeCursor } from './cursor.js';

describe('cursor decoding', () => {
  const invalidCursor = (decode: () => unknown): void => {
    expect(decode).toThrow(BadRequestException);
    expect(decode).toThrow('Invalid cursor');
  };

  it('preserves valid keyset and page cursors', () => {
    const payload = {
      createdAt: '2026-08-26T00:00:00.000Z',
      id: '0198a122-0c00-7000-8000-000000000001',
    };

    expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
    expect(decodePageCursor(Buffer.from('3').toString('base64url'))).toBe(3);
    expect(decodeCursor(null)).toBeNull();
    expect(decodePageCursor(null)).toBe(1);
  });

  it('rejects malformed keyset cursor input', () => {
    for (const cursor of [
      'not-base64url!',
      Buffer.from('{').toString('base64url'),
      Buffer.from(JSON.stringify({ id: 'not-a-uuid' })).toString('base64url'),
    ]) {
      invalidCursor(() => decodeCursor(cursor));
    }
  });

  it('rejects zero and fractional page cursors', () => {
    for (const value of ['0', '1.5']) {
      invalidCursor(() =>
        decodePageCursor(Buffer.from(value).toString('base64url')),
      );
    }
  });
});
