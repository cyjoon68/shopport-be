import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { JOSEError } from 'jose/errors';
import type { JWTPayload } from 'jose';
import type { Environment } from '../../config/environment.js';
import type { AuthProvider, VerifiedIdentity } from './auth.types.js';

const kakaoJwks = createRemoteJWKSet(
  new URL('https://kauth.kakao.com/.well-known/jwks.json'),
);

const readStringClaim = (claim: unknown, fallback: string): string =>
  typeof claim === 'string' && claim.length > 0 ? claim : fallback;

@Injectable()
export class ProviderTokenVerifier {
  public constructor(
    private readonly config: ConfigService<Environment, true>,
  ) {}

  public verify = async (
    provider: AuthProvider,
    idToken: string,
    nonce: string,
  ): Promise<VerifiedIdentity> => {
    const expectedAudience = this.config.get('KAKAO_NATIVE_APP_KEY', {
      infer: true,
    });
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(idToken, kakaoJwks, {
        issuer: 'https://kauth.kakao.com',
        audience: expectedAudience,
      }));
    } catch (error) {
      if (error instanceof JOSEError) {
        throw new UnauthorizedException('Invalid identity token');
      }
      throw error;
    }
    if (payload.nonce !== nonce) {
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
  };
}
