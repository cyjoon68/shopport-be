import { expect, it } from '@jest/globals';
import type { Pool } from 'pg';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';

import type { AiRepository } from '../src/modules/ai/ai.repository.js';
import type { StaleRunRecovery } from '../src/worker/stale-run-recovery.js';

type AiOwner = Readonly<{
  accessToken: string;
  accountId: string;
  conversationId: string;
}>;

type AiRuntimeFixture = Readonly<{
  aiRepository: AiRepository;
  baseUrl: string;
  createAiOwner: () => Promise<AiOwner>;
  pool: Pool;
  staleRunRecovery: StaleRunRecovery;
}>;

const waitForBlockedRunUpdates = async (
  pool: Pool,
  blockerPid: number,
  count: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{ count: number }>(
      `with recursive blocked(pid) as (
         select pid
         from pg_stat_activity
         where $1::int = any(pg_blocking_pids(pid))
         union
         select activity.pid
         from pg_stat_activity activity
         join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
       )
       select count(*)::int as count
       from blocked
       join pg_stat_activity using (pid)
       where datname = current_database()
         and wait_event_type = 'Lock'
         and query ilike '%update "ai_runs"%'`,
      [blockerPid],
    );
    if ((blocked.rows.at(0)?.count ?? 0) >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for ${count.toString()} blocked AI run updates`,
  );
};

export const registerAiRuntimeScenarios = (
  getFixture: () => AiRuntimeFixture,
): void => {
  it('rejects invalid external replay offsets for GET and POST', async () => {
    const { baseUrl, createAiOwner, pool } = getFixture();
    const owner = await createAiOwner();
    const runId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at,
        heartbeat_at, completed_at, stream_closed_at)
       values ($1, $2, $3, 'completed', $4, $4, $4, $4, $4)`,
      [runId, owner.accountId, owner.conversationId, now],
    );

    for (const offset of ['-1', '42-0', '+1', '1.5', '9223372036854775808']) {
      await request(baseUrl)
        .get('/v1/ai/chat')
        .query({ runId, offset })
        .set('authorization', `Bearer ${owner.accessToken}`)
        .expect(400)
        .expect(({ body }) => {
          expect(body).toEqual(
            expect.objectContaining({ message: 'Invalid replay request' }),
          );
        });
      await request(baseUrl)
        .post('/v1/ai/chat')
        .set('authorization', `Bearer ${owner.accessToken}`)
        .set('last-event-id', offset)
        .send({
          threadId: owner.conversationId,
          runId,
          messages: [{ id: uuidv7(), role: 'user', content: 'resume request' }],
          forwardedProps: {},
        })
        .expect(400)
        .expect(({ body }) => {
          expect(body).toEqual(
            expect.objectContaining({ message: 'Invalid replay request' }),
          );
        });
    }
  });

  it('closes and replays a pre-producer failure promptly', async () => {
    const { baseUrl, createAiOwner, pool } = getFixture();
    const owner = await createAiOwner();
    const runId = uuidv7();

    await request(baseUrl)
      .post('/v1/ai/chat')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({
        threadId: owner.conversationId,
        runId,
        messages: [
          { id: uuidv7(), role: 'user', content: 'pre-producer failure' },
        ],
        forwardedProps: {},
      })
      .expect(500);

    const failed = await pool.query<{
      status: string;
      completed_at: Date | null;
      stream_closed_at: Date | null;
    }>(
      `select status, completed_at, stream_closed_at
       from ai_runs
       where id = $1`,
      [runId],
    );
    const replay = await request(baseUrl)
      .get('/v1/ai/chat')
      .query({ runId, offset: '0' })
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(failed.rows.at(0)?.status).toBe('failed');
    expect(failed.rows.at(0)?.completed_at).toBeInstanceOf(Date);
    expect(failed.rows.at(0)?.stream_closed_at).toBeInstanceOf(Date);
    expect(replay.text.trim()).toBe('');
  }, 30_000);

  it('terminates producerless cancellation replay', async () => {
    const { baseUrl, createAiOwner, pool } = getFixture();
    const owner = await createAiOwner();
    const runId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $4)`,
      [
        runId,
        owner.accountId,
        owner.conversationId,
        now,
        new Date(now.getTime() + 60_000),
      ],
    );

    await request(baseUrl)
      .post('/v1/ai/chat/cancel')
      .set('authorization', `Bearer ${owner.accessToken}`)
      .send({ threadId: owner.conversationId, runId })
      .expect(200)
      .expect({ outcome: 'cancelled' });
    const replay = await request(baseUrl)
      .get(`/v1/ai/chat?runId=${runId}&offset=0`)
      .set('authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const cancelled = await pool.query<{
      status: string;
      completed_at: Date | null;
      stream_closed_at: Date | null;
    }>(
      `select status, completed_at, stream_closed_at
       from ai_runs
       where id = $1`,
      [runId],
    );

    expect(replay.text.trim()).toBe('');
    expect(cancelled.rows.at(0)?.status).toBe('cancelled');
    expect(cancelled.rows.at(0)?.completed_at).toBeInstanceOf(Date);
    expect(cancelled.rows.at(0)?.stream_closed_at).toBeInstanceOf(Date);
  }, 30_000);

  it('keeps concurrent cancellation and completion mutually exclusive', async () => {
    const { aiRepository, baseUrl, createAiOwner, pool } = getFixture();
    const owner = await createAiOwner();
    const runId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $4)`,
      [
        runId,
        owner.accountId,
        owner.conversationId,
        now,
        new Date(now.getTime() + 60_000),
      ],
    );
    const blocker = await pool.connect();
    let cancellation: Promise<unknown> | undefined;
    let completion: Promise<void> | undefined;
    let orchestrationError: Error | undefined;
    try {
      await blocker.query('begin');
      const blockerBackend = await blocker.query<{ pid: number }>(
        'select pg_backend_pid()::int as pid',
      );
      const blockerPid = blockerBackend.rows.at(0)?.pid;
      if (blockerPid === undefined)
        throw new Error('Expected blocker backend PID');
      await blocker.query('select id from ai_runs where id = $1 for update', [
        runId,
      ]);
      cancellation = Promise.resolve(
        request(baseUrl)
          .post('/v1/ai/chat/cancel')
          .set('authorization', `Bearer ${owner.accessToken}`)
          .send({ threadId: owner.conversationId, runId })
          .expect(200),
      );
      await waitForBlockedRunUpdates(pool, blockerPid, 1);
      completion = aiRepository.completeRun({
        runId,
        conversationId: owner.conversationId,
        messageId: uuidv7(),
        text: '경쟁 조건 응답',
        productRecommendations: [],
        askUser: null,
        providerIds: [],
      });
      await waitForBlockedRunUpdates(pool, blockerPid, 2);
      await blocker.query('commit');
    } catch (error) {
      orchestrationError =
        error instanceof Error ? error : new Error(String(error));
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    const [cancellationResult, completionResult] = await Promise.allSettled([
      cancellation ?? Promise.reject(new Error('Cancellation did not start')),
      completion ?? Promise.reject(new Error('Completion did not start')),
    ]);
    if (orchestrationError instanceof Error) throw orchestrationError;
    expect(cancellationResult).toMatchObject({
      status: 'fulfilled',
      value: { body: { outcome: 'cancelled' } },
    });
    expect(completionResult).toEqual({
      status: 'rejected',
      reason: expect.objectContaining({ message: 'AI run lease lost' }),
    });
    const terminalRun = await pool.query<{
      status: string;
      assistant_count: number;
    }>(
      `select r.status,
              count(m.id) filter (where m.role = 'assistant')::int as assistant_count
       from ai_runs r
       left join messages m on m.run_id = r.id
       where r.id = $1
       group by r.status`,
      [runId],
    );

    expect(terminalRun.rows).toEqual([
      { status: 'cancelled', assistant_count: 0 },
    ]);
  }, 30_000);

  it('reports completed cancellation when completion wins the row lock race', async () => {
    const { aiRepository, baseUrl, createAiOwner, pool } = getFixture();
    const owner = await createAiOwner();
    const runId = uuidv7();
    const now = new Date();
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $4)`,
      [
        runId,
        owner.accountId,
        owner.conversationId,
        now,
        new Date(now.getTime() + 60_000),
      ],
    );
    const blocker = await pool.connect();
    let cancellation: Promise<unknown> | undefined;
    let completion: Promise<void> | undefined;
    let orchestrationError: Error | undefined;
    try {
      await blocker.query('begin');
      const blockerBackend = await blocker.query<{ pid: number }>(
        'select pg_backend_pid()::int as pid',
      );
      const blockerPid = blockerBackend.rows.at(0)?.pid;
      if (blockerPid === undefined)
        throw new Error('Expected blocker backend PID');
      await blocker.query('select id from ai_runs where id = $1 for update', [
        runId,
      ]);
      completion = aiRepository.completeRun({
        runId,
        conversationId: owner.conversationId,
        messageId: uuidv7(),
        text: '완료 우선 응답',
        productRecommendations: [],
        askUser: null,
        providerIds: [],
      });
      await waitForBlockedRunUpdates(pool, blockerPid, 1);
      cancellation = Promise.resolve(
        request(baseUrl)
          .post('/v1/ai/chat/cancel')
          .set('authorization', `Bearer ${owner.accessToken}`)
          .send({ threadId: owner.conversationId, runId })
          .expect(200),
      );
      await waitForBlockedRunUpdates(pool, blockerPid, 2);
      await blocker.query('commit');
    } catch (error) {
      orchestrationError =
        error instanceof Error ? error : new Error(String(error));
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }

    const [completionResult, cancellationResult] = await Promise.allSettled([
      completion ?? Promise.reject(new Error('Completion did not start')),
      cancellation ?? Promise.reject(new Error('Cancellation did not start')),
    ]);
    if (orchestrationError instanceof Error) throw orchestrationError;
    expect(completionResult.status).toBe('fulfilled');
    expect(cancellationResult).toMatchObject({
      status: 'fulfilled',
      value: { body: { outcome: 'completed' } },
    });
    const terminalRun = await pool.query<{
      status: string;
      assistant_count: number;
    }>(
      `select r.status,
              count(m.id) filter (where m.role = 'assistant')::int as assistant_count
       from ai_runs r
       left join messages m on m.run_id = r.id
       where r.id = $1
       group by r.status`,
      [runId],
    );

    expect(terminalRun.rows).toEqual([
      { status: 'completed', assistant_count: 1 },
    ]);
  }, 30_000);

  it('recovers stale reserved runs once', async () => {
    const { createAiOwner, pool, staleRunRecovery } = getFixture();
    const owner = await createAiOwner();
    const now = new Date();
    const overdue = new Date(now.getTime() - 180_000);
    const future = new Date(now.getTime() + 180_000);
    const staleRunId = uuidv7();
    const freshRunId = uuidv7();
    const completedRunId = uuidv7();
    const cancelledRunId = uuidv7();

    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at,
        heartbeat_at, completed_at)
       values
       ($1, $5, $6, 'reserved', $7, $7, $7, null),
       ($2, $5, $6, 'reserved', $8, $8, $8, null),
       ($3, $5, $6, 'completed', $7, $7, $7, $8),
       ($4, $5, $6, 'cancelled', $7, $7, $7, $8)`,
      [
        staleRunId,
        freshRunId,
        completedRunId,
        cancelledRunId,
        owner.accountId,
        owner.conversationId,
        overdue,
        future,
      ],
    );

    await expect(staleRunRecovery.recover()).resolves.toBe(1);
    await expect(staleRunRecovery.recover()).resolves.toBe(0);

    const runs = await pool.query<{ id: string; status: string }>(
      `select id, status
       from ai_runs
       where id = any($1::uuid[])
       order by id`,
      [[staleRunId, freshRunId, completedRunId, cancelledRunId]],
    );
    const statuses = new Map(runs.rows.map(({ id, status }) => [id, status]));

    expect(statuses.get(staleRunId)).toBe('failed');
    expect(statuses.get(freshRunId)).toBe('reserved');
    expect(statuses.get(completedRunId)).toBe('completed');
    expect(statuses.get(cancelledRunId)).toBe('cancelled');
  }, 30_000);

  it('AI maintenance advisory lock prevents a second worker pass', async () => {
    const { createAiOwner, pool, staleRunRecovery } = getFixture();
    const owner = await createAiOwner();
    const staleRunId = uuidv7();
    const eventRunId = uuidv7();
    const now = new Date();
    const expired = new Date(now.getTime() - 60_000);
    await pool.query(
      `insert into ai_runs
       (id, account_id, conversation_id, status, started_at, deadline_at, heartbeat_at)
       values ($1, $2, $3, 'reserved', $4, $5, $5),
              ($6, $2, $3, 'completed', $4, $4, $4)`,
      [
        staleRunId,
        owner.accountId,
        owner.conversationId,
        expired,
        expired,
        eventRunId,
      ],
    );
    await pool.query(
      `insert into ai_run_events (run_id, chunk, expires_at)
       values ($1, $2, $3)`,
      [eventRunId, JSON.stringify({ type: 'text' }), expired],
    );
    await pool.query(
      `insert into rate_limits (key, hits, window_expires_at, blocked_until)
       values ('ai-maintenance-lock', 1, $1, null)`,
      [expired],
    );
    const blocker = await pool.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        "select pg_advisory_xact_lock(hashtextextended('shopport.ai-maintenance', 0))",
      );

      await expect(staleRunRecovery.recover()).resolves.toBe(0);
      await expect(
        pool.query(
          `select (select status from ai_runs where id = $1) as status,
                  (select count(*)::int from ai_run_events where run_id = $2) as events,
                  (select count(*)::int from rate_limits where key = 'ai-maintenance-lock') as rates`,
          [staleRunId, eventRunId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status: 'reserved', events: 1, rates: 1 }],
      });

      await blocker.query('commit');
      await expect(staleRunRecovery.recover()).resolves.toBe(1);
      await expect(
        pool.query(
          `select (select status from ai_runs where id = $1) as status,
                  (select count(*)::int from ai_run_events where run_id = $2) as events,
                  (select count(*)::int from rate_limits where key = 'ai-maintenance-lock') as rates`,
          [staleRunId, eventRunId],
        ),
      ).resolves.toMatchObject({
        rows: [{ status: 'failed', events: 0, rates: 0 }],
      });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
  }, 30_000);

  it('AI maintenance skips a rate limit refreshed under a row lock', async () => {
    const { pool, staleRunRecovery } = getFixture();
    const key = 'ai-maintenance-refresh';
    const now = new Date();
    const expired = new Date(now.getTime() - 60_000);
    const refreshed = new Date(now.getTime() + 60_000);
    await pool.query(
      `insert into rate_limits (key, hits, window_expires_at, blocked_until)
       values ($1, 1, $2, null)`,
      [key, expired],
    );
    const refresher = await pool.connect();
    try {
      await refresher.query('begin');
      await refresher.query(
        `update rate_limits
         set hits = 2, window_expires_at = $2, updated_at = $2
         where key = $1`,
        [key, refreshed],
      );

      await expect(staleRunRecovery.recover()).resolves.toBe(0);

      await refresher.query('commit');
      await expect(
        pool.query<{
          hits: number;
          window_expires_at: Date;
        }>(
          `select hits, window_expires_at
           from rate_limits
           where key = $1`,
          [key],
        ),
      ).resolves.toMatchObject({
        rows: [{ hits: 2, window_expires_at: refreshed }],
      });
    } finally {
      await refresher.query('rollback');
      refresher.release();
    }
  }, 30_000);
};
