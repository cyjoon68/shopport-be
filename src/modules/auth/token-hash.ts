import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { validate as validateUuid } from 'uuid';

const refreshSecretPattern = /^[A-Za-z\d_-]{43}$/u;

export const createRefreshSecret = (): string =>
  randomBytes(32).toString('base64url');

export const hashRefreshSecret = (secret: string, pepper: string): string =>
  createHmac('sha256', pepper).update(secret).digest('base64url');

export const refreshHashMatches = (
  actual: string,
  expected: string,
): boolean => {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};

export const formatRefreshToken = (sessionId: string, secret: string): string =>
  `${sessionId}.${secret}`;

export const parseRefreshToken = (
  token: string,
): Readonly<{ sessionId: string; secret: string }> | null => {
  const separator = token.indexOf('.');
  if (separator < 1 || separator === token.length - 1) return null;
  const sessionId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (
    !validateUuid(sessionId) ||
    !refreshSecretPattern.test(secret) ||
    Buffer.from(secret, 'base64url').toString('base64url') !== secret
  ) {
    return null;
  }
  return {
    sessionId,
    secret,
  };
};
