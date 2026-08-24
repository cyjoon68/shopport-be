import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

import type { Database } from '../../database/database.module.js';
import { DATABASE } from '../../database/database.module.js';
import {
  accounts,
  authIdentities,
  authSessions,
} from '../../database/schema.js';
import type { AccountSession, VerifiedIdentity } from './auth.types.js';

type RotateSessionInput = Readonly<{
  previousId: string;
  expectedHash: string;
  nextTokenHash: string;
  nextExpiresAt: Date;
  matches: (actual: string, expected: string) => boolean;
}>;

type RotateSessionResult =
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'replay' }>
  | Readonly<{ status: 'rotated'; accountId: string; sessionId: string }>;

@Injectable()
export class AuthRepository {
  public constructor(@Inject(DATABASE) private readonly database: Database) {}

  public findOrCreateAccount = async (
    identity: VerifiedIdentity,
  ): Promise<AccountSession> =>
    this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${identity.provider}), hashtext(${identity.subject}))`,
      );
      const existing = await transaction
        .select({
          accountId: accounts.id,
          displayName: accounts.displayName,
          profileImageUrl: accounts.profileImageUrl,
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
      await transaction.insert(accounts).values({
        id: accountId,
        displayName: identity.displayName,
        profileImageUrl: identity.profileImageUrl,
      });
      await transaction.insert(authIdentities).values({
        id: uuidv7(),
        accountId,
        provider: identity.provider,
        providerSubject: identity.subject,
      });
      return {
        accountId,
        displayName: identity.displayName,
        profileImageUrl: identity.profileImageUrl,
      };
    });

  public createSession = async (
    accountId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<string> => {
    const id = uuidv7();
    await this.database.insert(authSessions).values({
      id,
      accountId,
      tokenHash,
      expiresAt,
    });
    return id;
  };

  public isAccessActive = async (
    accountId: string,
    sessionId: string,
  ): Promise<boolean> => {
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
  };

  public rotateSession = (
    input: RotateSessionInput,
  ): Promise<RotateSessionResult> =>
    this.database.transaction(async (transaction) => {
      const sessions = await transaction
        .select({
          id: authSessions.id,
          accountId: authSessions.accountId,
          tokenHash: authSessions.tokenHash,
          expiresAt: authSessions.expiresAt,
          revokedAt: authSessions.revokedAt,
        })
        .from(authSessions)
        .innerJoin(accounts, eq(authSessions.accountId, accounts.id))
        .where(
          and(
            eq(authSessions.id, input.previousId),
            isNull(accounts.deletedAt),
          ),
        )
        .limit(1)
        .for('update');
      const session = sessions.at(0);
      if (!session) return { status: 'invalid' };
      if (
        !input.matches(session.tokenHash, input.expectedHash) ||
        session.expiresAt <= new Date()
      ) {
        return { status: 'invalid' };
      }
      if (session.revokedAt) {
        await transaction.execute(sql`
          with recursive compromised as (
            select ${authSessions.id} as id,
                   ${authSessions.replacedBySessionId} as next_id
            from ${authSessions}
            where ${authSessions.id} = ${input.previousId}
            union all
            select child.id, child.replaced_by_session_id
            from ${authSessions} child
            inner join compromised parent on child.id = parent.next_id
          )
          update ${authSessions}
          set revoked_at = coalesce(${authSessions.revokedAt}, now()),
              updated_at = now()
          where ${authSessions.id} in (
            select id from compromised where id <> ${input.previousId}
          )
        `);
        return { status: 'replay' };
      }
      const nextId = uuidv7();
      await transaction.insert(authSessions).values({
        id: nextId,
        accountId: session.accountId,
        tokenHash: input.nextTokenHash,
        expiresAt: input.nextExpiresAt,
      });
      await transaction
        .update(authSessions)
        .set({ revokedAt: new Date(), replacedBySessionId: nextId })
        .where(
          and(
            eq(authSessions.id, input.previousId),
            isNull(authSessions.revokedAt),
          ),
        );
      return {
        status: 'rotated',
        accountId: session.accountId,
        sessionId: nextId,
      };
    });

  public revokeSession = async (
    id: string,
    expectedHash: string,
  ): Promise<void> => {
    await this.database
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.id, id),
          eq(authSessions.tokenHash, expectedHash),
          isNull(authSessions.revokedAt),
        ),
      );
  };

  public revokeAccountSessions = async (accountId: string): Promise<void> => {
    await this.database
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(authSessions.accountId, accountId),
          isNull(authSessions.revokedAt),
        ),
      );
  };
}
