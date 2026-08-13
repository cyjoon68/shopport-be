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

  public async login(
    provider: AuthProvider,
    idToken: string,
    nonce: string,
  ): Promise<TokenPair> {
    const identity = await this.verifier.verify(provider, idToken, nonce);
    const account = await this.repository.findOrCreateAccount(
      identity,
      new Date(),
    );
    return this.issueTokens(account.accountId);
  }

  public async refresh(refreshToken: string): Promise<TokenPair> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw new UnauthorizedException('Invalid refresh token');
    const session = await this.repository.findSession(parsed.sessionId);
    if (!session) throw new UnauthorizedException('Invalid refresh token');
    if (session.revokedAt) {
      await this.repository.revokeAccountSessions(session.accountId);
      throw new UnauthorizedException('Refresh token replay detected');
    }
    const expectedHash = this.hash(parsed.secret);
    if (
      !refreshHashMatches(session.tokenHash, expectedHash) ||
      session.expiresAt <= new Date()
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    return this.issueTokens(session.accountId, session.id);
  }

  public async logout(refreshToken: string): Promise<void> {
    const parsed = parseRefreshToken(refreshToken);
    if (parsed) await this.repository.revokeSession(parsed.sessionId);
  }

  private readonly issueTokens = async (
    accountId: string,
    previousSessionId?: string,
  ): Promise<TokenPair> => {
    const secret = createRefreshSecret();
    const expiresAt = new Date(Date.now() + refreshTokenMilliseconds);
    const sessionId = previousSessionId
      ? await this.repository.rotateSession(
          previousSessionId,
          accountId,
          this.hash(secret),
          expiresAt,
        )
      : await this.repository.createSession(
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
