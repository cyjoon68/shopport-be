import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

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
  return {
    sessionId: token.slice(0, separator),
    secret: token.slice(separator + 1),
  };
};
