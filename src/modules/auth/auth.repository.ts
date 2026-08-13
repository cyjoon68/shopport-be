import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { DATABASE } from '../../database/database.module.js';
import type { Database } from '../../database/database.module.js';
import {
  accounts,
  authIdentities,
  authSessions,
  entitlements,
} from '../../database/schema.js';
import type { AccountSession, VerifiedIdentity } from './auth.types.js';

type SessionRecord = Readonly<{
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

@Injectable()
export class AuthRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public async findOrCreateAccount(
    identity: VerifiedIdentity,
    now: Date,
  ): Promise<AccountSession> {
    const existing = await this.database
      .select({
        accountId: accounts.id,
        displayName: accounts.displayName,
        profileImageUrl: accounts.profileImageUrl,
        trialStartedAt: accounts.trialStartedAt,
        trialEndsAt: accounts.trialEndsAt,
      })
      .from(authIdentities)
      .innerJoin(accounts, eq(authIdentities.accountId, accounts.id))
      .where(
        and(
          eq(authIdentities.provider, identity.provider),
          eq(authIdentities.providerSubject, identity.subject),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    const account = existing.at(0);
    if (account) return account;

    const accountId = uuidv7();
    const trialEndsAt = new Date(now.getTime() + 168 * 60 * 60 * 1_000);
    await this.database.transaction(async (transaction) => {
      await transaction.insert(accounts).values({
        id: accountId,
        displayName: identity.displayName,
        profileImageUrl: identity.profileImageUrl,
        trialStartedAt: now,
        trialEndsAt,
      });
      await transaction.insert(authIdentities).values({
        id: uuidv7(),
        accountId,
        provider: identity.provider,
        providerSubject: identity.subject,
      });
      await transaction
        .insert(entitlements)
        .values({ accountId, key: 'trial' });
    });
    return {
      accountId,
      displayName: identity.displayName,
      profileImageUrl: identity.profileImageUrl,
      trialStartedAt: now,
      trialEndsAt,
    };
  }

  public async createSession(
    accountId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<string> {
    const id = uuidv7();
    await this.database.insert(authSessions).values({
      id,
      accountId,
      tokenHash,
      expiresAt,
    });
    return id;
  }

  public async findSession(id: string): Promise<SessionRecord | null> {
    const rows = await this.database
      .select({
        id: authSessions.id,
        accountId: authSessions.accountId,
        tokenHash: authSessions.tokenHash,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .innerJoin(accounts, eq(authSessions.accountId, accounts.id))
      .where(and(eq(authSessions.id, id), isNull(accounts.deletedAt)))
      .limit(1);
    return rows.at(0) ?? null;
  }

  public async isAccessActive(
    accountId: string,
    sessionId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .select({ id: authSessions.id })
      .from(authSessions)
      .innerJoin(accounts, eq(authSessions.accountId, accounts.id))
      .where(
        and(
          eq(authSessions.id, sessionId),
          eq(authSessions.accountId, accountId),
          isNull(authSessions.revokedAt),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1);
    return rows.length === 1;
  }

  public async rotateSession(
    previousId: string,
    accountId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<string> {
    const nextId = uuidv7();
    await this.database.transaction(async (transaction) => {
      await transaction.insert(authSessions).values({
        id: nextId,
        accountId,
        tokenHash,
        expiresAt,
      });
      await transaction
        .update(authSessions)
        .set({ revokedAt: new Date(), replacedBySessionId: nextId })
        .where(eq(authSessions.id, previousId));
    });
    return nextId;
  }

  public async revokeSession(id: string): Promise<void> {
    await this.database
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.id, id), isNull(authSessions.revokedAt)));
  }

  public async revokeAccountSessions(accountId: string): Promise<void> {
    await this.database
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.accountId, accountId),
          isNull(authSessions.revokedAt),
        ),
      );
  }
}
