import { expect, it } from '@jest/globals';
import type { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';

type AuthBarrierWait = Readonly<{
  clear: () => void;
  promise: Promise<void>;
}>;

type AuthSessionFixture = Readonly<{
  baseUrl: string;
  pool: Pool;
  waitForAuthBarrier: (
    expectedMessage: string,
    timeoutMilliseconds?: number,
  ) => AuthBarrierWait;
}>;

const loginSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.literal(900),
});

const waitForBlockedBy = async (
  pool: Pool,
  blockerPid: number,
  count: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{ count: string }>(
      `select count(*)::text as count
       from pg_stat_activity
       where $1 = any(pg_blocking_pids(pid))`,
      [blockerPid],
    );
    if (Number(blocked.rows.at(0)?.count ?? 0) >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${String(count)} blocked sessions`);
};

export const registerAuthSessionScenarios = (
  getFixture: () => AuthSessionFixture,
): void => {
  it('serializes ancestor logout and child refresh in either lock order', async () => {
    const { baseUrl, pool } = getFixture();
    const createLineage = async (): Promise<
      Readonly<{
        accountId: string;
        child: z.infer<typeof loginSchema>;
        childId: string;
        root: z.infer<typeof loginSchema>;
        rootId: string;
      }>
    > => {
      const root = loginSchema.parse(
        (
          await request(baseUrl).post('/v1/auth/kakao').send({
            identityToken: 'integration-kakao-token',
            nonce: 'ancestor-race',
          })
        ).body,
      );
      const childResponse = await request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: root.refreshToken })
        .expect(200);
      const child = loginSchema.parse(childResponse.body);
      const [rootId] = root.refreshToken.split('.');
      const [childId] = child.refreshToken.split('.');
      if (!rootId || !childId) throw new Error('Expected lineage session IDs');
      const account = await pool.query<{ account_id: string }>(
        'select account_id from auth_sessions where id = $1',
        [rootId],
      );
      const accountId = account.rows.at(0)?.account_id;
      if (!accountId) throw new Error('Expected lineage account');
      return { accountId, child, childId, root, rootId };
    };

    const refreshFirst = await createLineage();
    const refreshBlocker = await pool.connect();
    let refreshRequest: Promise<request.Response> | undefined;
    let ancestorLogout: Promise<request.Response> | undefined;
    try {
      const blocker = await refreshBlocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const blockerPid = blocker.rows.at(0)?.pid;
      if (!blockerPid) throw new Error('Expected blocker PID');
      await refreshBlocker.query(
        'select pg_advisory_lock(hashtextextended($1, 0))',
        [refreshFirst.accountId],
      );
      refreshRequest = request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: refreshFirst.child.refreshToken })
        .then((response) => response);
      await waitForBlockedBy(pool, blockerPid, 1);
      ancestorLogout = request(baseUrl)
        .post('/v1/auth/logout')
        .send({ refreshToken: refreshFirst.root.refreshToken })
        .then((response) => response);
      await waitForBlockedBy(pool, blockerPid, 2);
      await refreshBlocker.query(
        'select pg_advisory_unlock(hashtextextended($1, 0))',
        [refreshFirst.accountId],
      );
      const [refreshResponse, logoutResponse] = await Promise.all([
        refreshRequest,
        ancestorLogout,
      ]);
      expect(refreshResponse.status).toBe(200);
      expect(logoutResponse.status).toBe(204);
      const grandchild = loginSchema.parse(refreshResponse.body);
      const [grandchildId] = grandchild.refreshToken.split('.');
      if (!grandchildId) throw new Error('Expected grandchild session ID');
      const sessions = await pool.query<{
        id: string;
        revoked_at: Date | null;
      }>(
        `select id, revoked_at
         from auth_sessions
         where id = any($1::uuid[])`,
        [[refreshFirst.rootId, refreshFirst.childId, grandchildId]],
      );
      expect(sessions.rows).toHaveLength(3);
      expect(sessions.rows.every(({ revoked_at }) => revoked_at !== null)).toBe(
        true,
      );
      await request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: grandchild.refreshToken })
        .expect(401);
      await request(baseUrl)
        .post('/graphql')
        .set('authorization', `Bearer ${grandchild.accessToken}`)
        .send({ query: '{ viewer { id } }' })
        .expect(200)
        .expect(({ text }) => {
          expect(text).toContain('UNAUTHENTICATED');
        });
    } finally {
      await refreshBlocker.query(
        'select pg_advisory_unlock(hashtextextended($1, 0))',
        [refreshFirst.accountId],
      );
      refreshBlocker.release();
      await Promise.allSettled(
        [refreshRequest, ancestorLogout].filter(
          (pending): pending is Promise<request.Response> =>
            pending !== undefined,
        ),
      );
    }

    const logoutFirst = await createLineage();
    const logoutBlocker = await pool.connect();
    let logoutRequest: Promise<request.Response> | undefined;
    let childRefresh: Promise<request.Response> | undefined;
    try {
      const blocker = await logoutBlocker.query<{ pid: number }>(
        'select pg_backend_pid() as pid',
      );
      const blockerPid = blocker.rows.at(0)?.pid;
      if (!blockerPid) throw new Error('Expected blocker PID');
      await logoutBlocker.query(
        'select pg_advisory_lock(hashtextextended($1, 0))',
        [logoutFirst.accountId],
      );
      logoutRequest = request(baseUrl)
        .post('/v1/auth/logout')
        .send({ refreshToken: logoutFirst.root.refreshToken })
        .then((response) => response);
      await waitForBlockedBy(pool, blockerPid, 1);
      childRefresh = request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: logoutFirst.child.refreshToken })
        .then((response) => response);
      await waitForBlockedBy(pool, blockerPid, 2);
      await logoutBlocker.query(
        'select pg_advisory_unlock(hashtextextended($1, 0))',
        [logoutFirst.accountId],
      );
      const [logoutResponse, refreshResponse] = await Promise.all([
        logoutRequest,
        childRefresh,
      ]);
      expect(logoutResponse.status).toBe(204);
      expect(refreshResponse.status).toBe(401);
      const sessions = await pool.query<{
        id: string;
        replaced_by_session_id: string | null;
        revoked_at: Date | null;
      }>(
        `select id, replaced_by_session_id, revoked_at
         from auth_sessions
         where id = any($1::uuid[])`,
        [[logoutFirst.rootId, logoutFirst.childId]],
      );
      expect(sessions.rows).toHaveLength(2);
      expect(sessions.rows.every(({ revoked_at }) => revoked_at !== null)).toBe(
        true,
      );
      expect(
        sessions.rows.find(({ id }) => id === logoutFirst.childId)
          ?.replaced_by_session_id,
      ).toBeNull();
    } finally {
      await logoutBlocker.query(
        'select pg_advisory_unlock(hashtextextended($1, 0))',
        [logoutFirst.accountId],
      );
      logoutBlocker.release();
      await Promise.allSettled(
        [logoutRequest, childRefresh].filter(
          (pending): pending is Promise<request.Response> =>
            pending !== undefined,
        ),
      );
    }
  }, 30_000);

  it('rejects every token when refresh and logout contend in either lock order', async () => {
    const { baseUrl, pool, waitForAuthBarrier } = getFixture();
    const refreshWinnerLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: 'integration-kakao-token',
          nonce: 'refresh-wins',
        })
      ).body,
    );
    const logoutWinnerLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: 'integration-kakao-token',
          nonce: 'logout-wins',
        })
      ).body,
    );
    const unrelatedLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: 'integration-kakao-token',
          nonce: 'second-account',
        })
      ).body,
    );
    const [refreshWinnerSessionId] = refreshWinnerLogin.refreshToken.split('.');
    const [logoutWinnerSessionId] = logoutWinnerLogin.refreshToken.split('.');
    const [unrelatedSessionId] = unrelatedLogin.refreshToken.split('.');
    if (
      !refreshWinnerSessionId ||
      !logoutWinnerSessionId ||
      !unrelatedSessionId
    ) {
      throw new Error('Expected refresh token session IDs');
    }
    const account = await pool.query<{ account_id: string }>(
      'select account_id from auth_sessions where id = $1',
      [refreshWinnerSessionId],
    );
    const accountId = account.rows.at(0)?.account_id;
    if (!accountId) throw new Error('Expected refresh winner account');

    const refreshWins = await (async (): Promise<
      Readonly<{
        logoutStatus: number;
        refreshStatus: number;
        tokens: z.infer<typeof loginSchema>;
      }>
    > => {
      const blocker = await pool.connect();
      let barrier: AuthBarrierWait | undefined;
      try {
        await pool.query(`
          create or replace function auth_session_refresh_barrier()
          returns trigger language plpgsql as $$
          begin
            raise notice 'refresh-lock-held';
            perform pg_advisory_xact_lock(73001);
            return new;
          end
          $$;
          create trigger auth_session_refresh_barrier
          before insert on auth_sessions
          for each row
          when (new.account_id = '${accountId}'::uuid)
          execute function auth_session_refresh_barrier()
        `);
        await blocker.query('select pg_advisory_lock(73001)');
        barrier = waitForAuthBarrier('refresh-lock-held');
        const refreshRequest = request(baseUrl)
          .post('/v1/auth/refresh')
          .send({ refreshToken: refreshWinnerLogin.refreshToken })
          .then((response) => response);
        await barrier.promise;
        const logoutRequest = request(baseUrl)
          .post('/v1/auth/logout')
          .send({ refreshToken: refreshWinnerLogin.refreshToken })
          .then((response) => response);
        await blocker.query('select pg_advisory_unlock(73001)');
        const [refreshResponse, logoutResponse] = await Promise.all([
          refreshRequest,
          logoutRequest,
        ]);
        return {
          logoutStatus: logoutResponse.status,
          refreshStatus: refreshResponse.status,
          tokens: loginSchema.parse(refreshResponse.body),
        };
      } finally {
        barrier?.clear();
        try {
          await blocker.query('select pg_advisory_unlock(73001)');
        } finally {
          blocker.release();
          await pool.query(`
            drop trigger if exists auth_session_refresh_barrier on auth_sessions;
            drop function if exists auth_session_refresh_barrier()
          `);
        }
      }
    })();

    const logoutWins = await (async (): Promise<
      Readonly<{ logoutStatus: number; refreshStatus: number }>
    > => {
      const blocker = await pool.connect();
      let barrier: AuthBarrierWait | undefined;
      try {
        await pool.query(`
          create or replace function auth_session_logout_barrier()
          returns trigger language plpgsql as $$
          begin
            raise notice 'logout-lock-held';
            perform pg_advisory_xact_lock(73002);
            return new;
          end
          $$;
          create trigger auth_session_logout_barrier
          before update on auth_sessions
          for each row
          when (
            old.id = '${logoutWinnerSessionId}'::uuid
            and old.revoked_at is null
            and new.revoked_at is not null
          )
          execute function auth_session_logout_barrier()
        `);
        await blocker.query('select pg_advisory_lock(73002)');
        barrier = waitForAuthBarrier('logout-lock-held');
        const logoutRequest = request(baseUrl)
          .post('/v1/auth/logout')
          .send({ refreshToken: logoutWinnerLogin.refreshToken })
          .then((response) => response);
        await barrier.promise;
        const refreshRequest = request(baseUrl)
          .post('/v1/auth/refresh')
          .send({ refreshToken: logoutWinnerLogin.refreshToken })
          .then((response) => response);
        await blocker.query('select pg_advisory_unlock(73002)');
        const [logoutResponse, refreshResponse] = await Promise.all([
          logoutRequest,
          refreshRequest,
        ]);
        return {
          logoutStatus: logoutResponse.status,
          refreshStatus: refreshResponse.status,
        };
      } finally {
        barrier?.clear();
        try {
          await blocker.query('select pg_advisory_unlock(73002)');
        } finally {
          blocker.release();
          await pool.query(`
            drop trigger if exists auth_session_logout_barrier on auth_sessions;
            drop function if exists auth_session_logout_barrier()
          `);
        }
      }
    })();

    expect(refreshWins.refreshStatus).toBe(200);
    expect(refreshWins.logoutStatus).toBe(204);
    expect(logoutWins.logoutStatus).toBe(204);
    expect(logoutWins.refreshStatus).toBe(401);

    const [refreshWinnerChildId] = refreshWins.tokens.refreshToken.split('.');
    if (!refreshWinnerChildId) {
      throw new Error('Expected refresh winner child session ID');
    }
    const racedSessions = await pool.query<{
      id: string;
      revoked_at: Date | null;
    }>(
      `select id, revoked_at
       from auth_sessions
       where id = any($1::uuid[])`,
      [
        [
          refreshWinnerSessionId,
          refreshWinnerChildId,
          logoutWinnerSessionId,
          unrelatedSessionId,
        ],
      ],
    );
    const racedSessionStates = new Map(
      racedSessions.rows.map(({ id, revoked_at }) => [id, revoked_at]),
    );
    expect(racedSessionStates.size).toBe(4);
    expect(racedSessionStates.get(refreshWinnerSessionId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(refreshWinnerChildId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(logoutWinnerSessionId)).toBeInstanceOf(Date);
    expect(racedSessionStates.get(unrelatedSessionId)).toBeNull();

    const rejectedAccessTokens = [
      refreshWinnerLogin.accessToken,
      refreshWins.tokens.accessToken,
      logoutWinnerLogin.accessToken,
    ];
    for (const token of rejectedAccessTokens) {
      await request(baseUrl)
        .post('/graphql')
        .set('authorization', `Bearer ${token}`)
        .send({ query: '{ viewer { id } }' })
        .expect(200)
        .expect(({ text }) => {
          expect(text).toContain('UNAUTHENTICATED');
        });
    }
    const rejectedRefreshTokens = [
      refreshWinnerLogin.refreshToken,
      refreshWins.tokens.refreshToken,
      logoutWinnerLogin.refreshToken,
    ];
    for (const token of rejectedRefreshTokens) {
      await request(baseUrl)
        .post('/v1/auth/refresh')
        .send({ refreshToken: token })
        .expect(401);
    }

    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${unrelatedLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).not.toContain('UNAUTHENTICATED');
      });
  }, 30_000);

  it('bounds auth barrier notice waits', async () => {
    const { waitForAuthBarrier } = getFixture();
    const barrier = waitForAuthBarrier('missing-notice', 0);

    await expect(barrier.promise).rejects.toThrow(
      'Timed out waiting for missing-notice',
    );
  });

  it('revokes the access session on logout', async () => {
    const { baseUrl } = getFixture();
    const logoutLogin = loginSchema.parse(
      (
        await request(baseUrl).post('/v1/auth/kakao').send({
          identityToken: 'integration-kakao-token',
          nonce: 'logout-idempotency',
        })
      ).body,
    );
    const [sessionId, secret] = logoutLogin.refreshToken.split('.');
    if (!sessionId || !secret) throw new Error('Expected refresh token parts');
    const wrongSecret = `${secret.startsWith('A') ? 'B' : 'A'}${secret.slice(1)}`;

    await request(baseUrl)
      .post('/v1/auth/refresh')
      .send({ refreshToken: `not-a-uuid.${'A'.repeat(43)}` })
      .expect(401);
    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: `not-a-uuid.${'A'.repeat(43)}` })
      .expect(204);
    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: `${sessionId}.${wrongSecret}` })
      .expect(204);
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${logoutLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).not.toContain('UNAUTHENTICATED');
      });

    await request(baseUrl)
      .post('/v1/auth/logout')
      .send({ refreshToken: logoutLogin.refreshToken })
      .expect(204);
    await request(baseUrl)
      .post('/graphql')
      .set('authorization', `Bearer ${logoutLogin.accessToken}`)
      .send({ query: '{ viewer { id } }' })
      .expect(200)
      .expect(({ text }) => {
        expect(text).toContain('UNAUTHENTICATED');
      });
  });
};
