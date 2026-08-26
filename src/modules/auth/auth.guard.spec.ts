import { jest } from '@jest/globals';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { type AuthenticatedRequest, AuthGuard } from './auth.guard.js';
import type { AuthRepository } from './auth.repository.js';

const accountId = '0198a122-0c00-7000-8000-000000000001';
const sessionId = '0198a122-0c00-7000-8000-000000000002';
const secret = 'test-secret-at-least-32-bytes-long';

const createContext = (token: string): ExecutionContext => {
  const request = {
    headers: { authorization: `Bearer ${token}` },
  } as AuthenticatedRequest;
  return {
    getClass: () => AuthGuard,
    getHandler: () => createContext,
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
};

const verifyJwt = new JwtService({
  secret,
  verifyOptions: { audience: 'shopport' },
});

const invalidAccessTokens: ReadonlyArray<
  readonly [string, () => Promise<string>]
> = [
  ['malformed', (): Promise<string> => Promise.resolve('not-a-jwt')],
  [
    'expired',
    (): Promise<string> =>
      new JwtService({
        secret,
        signOptions: { audience: 'shopport', expiresIn: -1 },
      }).signAsync({ sub: accountId, sessionId }),
  ],
  [
    'wrong-audience',
    (): Promise<string> =>
      new JwtService({
        secret,
        signOptions: { audience: 'another-service' },
      }).signAsync({ sub: accountId, sessionId }),
  ],
  [
    'bad-signature',
    (): Promise<string> =>
      new JwtService({
        secret: 'another-test-secret-at-least-32-bytes',
        signOptions: { audience: 'shopport' },
      }).signAsync({ sub: accountId, sessionId }),
  ],
];

describe('AuthGuard', () => {
  it.each(invalidAccessTokens)(
    'normalizes %s access token verification failures',
    async (_kind, tokenFor) => {
      const isAccessActive = jest.fn(() => Promise.resolve(true));
      const guard = new AuthGuard(
        { getAllAndOverride: () => false } as unknown as Reflector,
        verifyJwt,
        { isAccessActive } as unknown as AuthRepository,
      );

      await expect(
        guard.canActivate(createContext(await tokenFor())),
      ).rejects.toEqual(new UnauthorizedException('Invalid access token'));
      expect(isAccessActive).not.toHaveBeenCalled();
    },
  );
});
