import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Environment } from '../../config/environment.js';
import type { AuthProvider, VerifiedIdentity } from './auth.types.js';

const appleJwks = createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
);
const kakaoJwks = createRemoteJWKSet(
  new URL('https://kauth.kakao.com/.well-known/jwks.json'),
);

const nonceDigest = (nonce: string): string =>
  createHash('sha256').update(nonce).digest('hex');

const readStringClaim = (claim: unknown, fallback: string): string =>
  typeof claim === 'string' && claim.length > 0 ? claim : fallback;

@Injectable()
export class ProviderTokenVerifier {
  public constructor(
    private readonly config: ConfigService<Environment, true>,
  ) {}

  public async verify(
    provider: AuthProvider,
    idToken: string,
    nonce: string,
  ): Promise<VerifiedIdentity> {
    if (
      this.config.get('ALLOW_DEMO_AUTH', { infer: true }) &&
      idToken === 'demo'
    ) {
      return {
        provider,
        subject: `demo-${provider}`,
        displayName:
          provider === 'apple' ? 'Apple 체험 사용자' : '카카오 체험 사용자',
        profileImageUrl: null,
      };
    }

    const expectedAudience =
      provider === 'apple'
        ? this.config.get('APPLE_CLIENT_ID', { infer: true })
        : this.config.get('KAKAO_NATIVE_APP_KEY', { infer: true });
    const issuer =
      provider === 'apple'
        ? 'https://appleid.apple.com'
        : 'https://kauth.kakao.com';
    const keySet = provider === 'apple' ? appleJwks : kakaoJwks;
    const { payload } = await jwtVerify(idToken, keySet, {
      issuer,
      audience: expectedAudience,
    });
    const expectedNonce = provider === 'apple' ? nonceDigest(nonce) : nonce;
    if (payload.nonce !== expectedNonce) {
      throw new UnauthorizedException('Invalid identity nonce');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new UnauthorizedException('Invalid identity subject');
    }

    return {
      provider,
      subject: payload.sub,
      displayName: readStringClaim(
        payload.nickname ?? payload.name,
        'Shopport 사용자',
      ),
      profileImageUrl:
        typeof payload.picture === 'string' ? payload.picture : null,
    };
  }
}
