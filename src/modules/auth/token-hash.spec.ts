import { v7 as uuidv7 } from 'uuid';
import {
  createRefreshSecret,
  formatRefreshToken,
  parseRefreshToken,
} from './token-hash.js';

describe('refresh token parsing', () => {
  it('accepts a UUID session and canonical 32-byte base64url secret', () => {
    const sessionId = uuidv7();
    const secret = createRefreshSecret();

    expect(secret).toHaveLength(43);
    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toEqual({
      sessionId,
      secret,
    });
  });

  it.each([
    ['not-a-uuid', 'A'.repeat(43)],
    [uuidv7(), 'short'],
    [uuidv7(), `${'A'.repeat(42)}=`],
    [uuidv7(), `${'A'.repeat(43)}.extra`],
  ])('rejects malformed refresh token components', (sessionId, secret) => {
    expect(parseRefreshToken(formatRefreshToken(sessionId, secret))).toBeNull();
  });
});
