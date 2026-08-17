import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Environment } from '../../config/environment.js';
import { AuthRepository } from './auth.repository.js';
import type { AuthProvider, TokenPair } from './auth.types.js';
import { ProviderTokenVerifier } from './provider-token-verifier.js';
import {
  createRefreshSecret,
  formatRefreshToken,
  hashRefreshSecret,
  parseRefreshToken,
  refreshHashMatches,
} from './token-hash.js';

const accessTokenSeconds = 15 * 60;
const refreshTokenMilliseconds = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class AuthService {
  public constructor(
    private readonly repository: AuthRepository,
    private readonly verifier: ProviderTokenVerifier,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  public login = async (
    provider: AuthProvider,
    idToken: string,
    nonce: string,
  ): Promise<TokenPair> => {
    const verified = await this.verifier.verify(provider, idToken, nonce);
    const account = await this.repository.findOrCreateAccount(
      verified,
      new Date(),
    );
    return this.issueTokens(account.accountId);
  };

  public refresh = async (refreshToken: string): Promise<TokenPair> => {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException('Invalid refresh token');
    const expectedHash = this.hash(parsed.secret);
    const secret = createRefreshSecret();
    const rotated = await this.repository.rotateSession({
      previousId: parsed.sessionId,
      expectedHash,
      nextTokenHash: this.hash(secret),
      nextExpiresAt: new Date(Date.now() + refreshTokenMilliseconds),
      matches: refreshHashMatches,
    });
    if (rotated.status === 'replay') {
      throw new UnauthorizedException('Refresh token replay detected');
    }
    if (rotated.status === 'invalid') {
      throw new UnauthorizedException('Invalid refresh token');
    }
    const accessToken = await this.jwt.signAsync({
      sub: rotated.accountId,
      sessionId: rotated.sessionId,
    });
    return {
      accessToken,
      refreshToken: formatRefreshToken(rotated.sessionId, secret),
      expiresIn: accessTokenSeconds,
    };
  };

  public logout = async (refreshToken: string): Promise<void> => {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed) {
      await this.repository.revokeSession(
        parsed.sessionId,
        this.hash(parsed.secret),
      );
    }
  };

  private readonly issueTokens = async (
    accountId: string,
  ): Promise<TokenPair> => {
    const secret = createRefreshSecret();
    const expiresAt = new Date(Date.now() + refreshTokenMilliseconds);
    const sessionId = await this.repository.createSession(
      accountId,
      this.hash(secret),
      expiresAt,
    );
    const accessToken = await this.jwt.signAsync({
      sub: accountId,
      sessionId,
    });
    return {
      accessToken,
      refreshToken: formatRefreshToken(sessionId, secret),
      expiresIn: accessTokenSeconds,
    };
  };

  private readonly hash = (secret: string): string =>
    hashRefreshSecret(secret, this.config.get('JWT_SECRET', { infer: true }));
}
