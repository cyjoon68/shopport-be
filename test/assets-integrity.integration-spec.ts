import { ConfigService } from '@nestjs/config';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

import type { Environment } from '../src/config/environment.js';
import * as schema from '../src/database/schema.js';
import type { AssetRecord } from '../src/modules/assets/assets.repository.js';
import { AssetsRepository } from '../src/modules/assets/assets.repository.js';
import { AssetsResolver } from '../src/modules/assets/assets.resolver.js';
import { AssetsService } from '../src/modules/assets/assets.service.js';
import { assetKeysFor } from '../src/modules/assets/keys.js';
import type { AuthenticatedRequest } from '../src/modules/auth/auth.guard.js';
import { ConversationRepository } from '../src/modules/conversations/conversation.repository.js';
import { ProfileRepository } from '../src/modules/profile/profile.repository.js';

type AssetPurgeRow = Readonly<{
  eligible: boolean;
  nextAttemptAt: Date;
  payload: Readonly<{
    accountId: string;
    assetId: string;
    originalKey: string;
    normalizedKey: string;
  }>;
}>;

const accountId = '0198a122-0c00-7000-8000-000000000001';
const activeConversationId = '0198a122-0c00-7000-8000-000000000002';
const deletedConversationId = '0198a122-0c00-7000-8000-000000000003';
const earlyAssetId = '0198a122-0c00-7000-8000-000000000004';
const lateAssetId = '0198a122-0c00-7000-8000-000000000005';
const otherConversationId = '0198a122-0c00-7000-8000-000000000007';
const request = {
  user: {
    sessionId: '0198a122-0c00-7000-8000-000000000006',
    sub: accountId,
  },
} as AuthenticatedRequest;

const waitForBlockedBy = async (
  pool: Pool,
  blockerPid: number,
  count: number,
): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = await pool.query<{ count: string }>(
      `with recursive blocked(pid) as (
         select pid
         from pg_stat_activity
         where $1 = any(pg_blocking_pids(pid))
         union
         select activity.pid
         from pg_stat_activity activity
         join blocked on blocked.pid = any(pg_blocking_pids(activity.pid))
       )
       select count(*)::text as count from blocked`,
      [blockerPid],
    );
    if (Number(blocked.rows.at(0)?.count ?? 0) >= count) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${String(count)} blocked sessions`);
};

describe('asset deletion and conversation integrity', () => {
  let pool: Pool;
  let postgres: StartedPostgreSqlContainer;
  let repository: AssetsRepository;
  let resolver: AssetsResolver;
  let conversations: ConversationRepository;
  let profiles: ProfileRepository;

  beforeAll(async () => {
    postgres = await new PostgreSqlContainer('postgres:16.8-alpine')
      .withDatabase('shopport')
      .withUsername('shopport')
      .withPassword('shopport')
      .start();
    pool = new Pool({ connectionString: postgres.getConnectionUri() });
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await migrate(drizzle(pool), { migrationsFolder: './migrations' });
    const database = drizzle(pool, { schema });
    repository = new AssetsRepository(database);
    conversations = new ConversationRepository(database);
    profiles = new ProfileRepository(database);
    resolver = new AssetsResolver(
      new AssetsService(
        repository,
        new ConfigService<Environment, true>({
          AWS_REGION: 'ap-northeast-2',
          AWS_ENDPOINT_URL: 'http://localhost:4566',
          ASSET_BUCKET: 'shopport-assets',
          RAW_ASSET_BUCKET: 'shopport-raw',
          NORMALIZED_ASSET_BUCKET: 'shopport-normalized',
          ARCHIVE_BUCKET: 'shopport-archive',
          ASSET_CDN_HOST: 'assets.example.com',
        } as Environment),
      ),
    );
  }, 120_000);

  afterEach(async () => {
    await pool.query(
      'TRUNCATE outbox, assets, conversations, accounts CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await postgres.stop();
  });

  it('delays early purge, immediately exposes late purge, and uses deterministic keys', async () => {
    const earlyCreatedAt = new Date(Date.now() - 5 * 60 * 1_000);
    const lateCreatedAt = new Date(Date.now() - 20 * 60 * 1_000);
    await insertAccountAndConversation(pool, activeConversationId, null);
    await insertAsset(pool, earlyAssetId, earlyCreatedAt);
    await insertAsset(pool, lateAssetId, lateCreatedAt);

    await expect(repository.delete(accountId, earlyAssetId)).resolves.toBe(
      true,
    );
    await expect(repository.delete(accountId, lateAssetId)).resolves.toBe(true);

    const rows = await pool.query<AssetPurgeRow>(
      `
        SELECT
          payload,
          next_attempt_at AS "nextAttemptAt",
          next_attempt_at <= now() AS eligible
        FROM outbox
        WHERE topic = 'asset.purge'
        ORDER BY payload->>'assetId'
      `,
    );
    const early = rows.rows.find((row) => row.payload.assetId === earlyAssetId);
    const late = rows.rows.find((row) => row.payload.assetId === lateAssetId);

    expect(early).toEqual({
      eligible: false,
      nextAttemptAt: new Date(earlyCreatedAt.getTime() + 15 * 60 * 1_000),
      payload: {
        accountId,
        assetId: earlyAssetId,
        originalKey: assetKeysFor(accountId, earlyAssetId).original,
        normalizedKey: assetKeysFor(accountId, earlyAssetId).normalized,
      },
    });
    expect(late).toMatchObject({
      eligible: true,
      payload: {
        accountId,
        assetId: lateAssetId,
        originalKey: assetKeysFor(accountId, lateAssetId).original,
        normalizedKey: assetKeysFor(accountId, lateAssetId).normalized,
      },
    });
  });

  it('returns not found and inserts no asset for a soft-deleted conversation', async () => {
    await insertAccountAndConversation(pool, deletedConversationId, new Date());

    await expect(
      resolver.createAssetUpload(request, {
        conversationId: deletedConversationId,
        contentType: 'image/jpeg',
        byteSize: 128,
      }),
    ).resolves.toEqual({
      upload: null,
      userErrors: [expect.objectContaining({ code: 'NOT_FOUND' })],
    });
    await expect(
      repository.createForLiveConversation({
        id: earlyAssetId,
        accountId,
        conversationId: deletedConversationId,
        originalKey: assetKeysFor(accountId, earlyAssetId).original,
        contentType: 'image/jpeg',
        byteSize: 128,
      }),
    ).resolves.toBeNull();
    await expect(
      pool.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM assets WHERE conversation_id = $1',
        [deletedConversationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('resolves assets only inside the authorized conversation batch', async () => {
    await insertAccountAndConversation(pool, activeConversationId, null);
    await pool.query(
      `
        INSERT INTO conversations (id, account_id, title)
        VALUES ($1, $2, 'Other conversation')
      `,
      [otherConversationId, accountId],
    );
    await insertAsset(pool, earlyAssetId, new Date(), activeConversationId);
    await insertAsset(pool, lateAssetId, new Date(), otherConversationId);

    await expect(
      repository.findForConversations(
        [earlyAssetId, lateAssetId],
        [activeConversationId],
      ),
    ).resolves.toEqual([
      expect.objectContaining({ id: earlyAssetId, status: 'pending_upload' }),
    ]);
  });

  it.each(['conversation', 'account'] as const)(
    'serializes asset creation before and after %s deletion',
    async (parent) => {
      const parentId =
        parent === 'conversation' ? activeConversationId : accountId;
      const lockTable =
        parent === 'conversation' ? 'conversations' : 'accounts';
      const remove = (): Promise<boolean> =>
        parent === 'conversation'
          ? conversations.delete(accountId, activeConversationId)
          : profiles.deleteAccount(accountId);
      const run = async (
        first: 'create' | 'delete',
        assetId: string,
      ): Promise<readonly [AssetRecord | null, boolean]> => {
        await insertAccountAndConversation(pool, activeConversationId, null);
        const blocker = await pool.connect();
        let create: Promise<AssetRecord | null> | undefined;
        let deletion: Promise<boolean> | undefined;
        const createAsset = (): Promise<AssetRecord | null> =>
          repository.createForLiveConversation({
            id: assetId,
            accountId,
            conversationId: activeConversationId,
            originalKey: assetKeysFor(accountId, assetId).original,
            contentType: 'image/jpeg',
            byteSize: 128,
          });
        try {
          const pid = await blocker.query<{ pid: number }>(
            'select pg_backend_pid() as pid',
          );
          const blockerPid = pid.rows.at(0)?.pid;
          if (!blockerPid) throw new Error('Expected blocker PID');
          if (first === 'create') {
            await pool.query(`
              create function asset_insert_barrier()
              returns trigger language plpgsql as $$
              begin
                perform pg_advisory_xact_lock(74001);
                return new;
              end
              $$;
              create trigger asset_insert_barrier
              before insert on assets
              for each row execute function asset_insert_barrier()
            `);
            await blocker.query('select pg_advisory_lock(74001)');
            create = createAsset();
            await waitForBlockedBy(pool, blockerPid, 1);
            deletion = remove();
            await waitForBlockedBy(pool, blockerPid, 2);
            await blocker.query('select pg_advisory_unlock(74001)');
          } else {
            await blocker.query('begin');
            await blocker.query(
              `select id from ${lockTable} where id = $1 for update`,
              [parentId],
            );
            deletion = remove();
            await waitForBlockedBy(pool, blockerPid, 1);
            create = createAsset();
            await waitForBlockedBy(pool, blockerPid, 2);
            await blocker.query('commit');
          }
          return await Promise.all([create, deletion] as const);
        } finally {
          await blocker.query('rollback');
          await blocker.query('select pg_advisory_unlock(74001)');
          blocker.release();
          await Promise.allSettled([
            ...(create ? [create] : []),
            ...(deletion ? [deletion] : []),
          ]);
          await pool.query(`
            drop trigger if exists asset_insert_barrier on assets;
            drop function if exists asset_insert_barrier()
          `);
        }
      };

      const createFirst = await run('create', earlyAssetId);
      expect(createFirst[0]).toMatchObject({ id: earlyAssetId });
      expect(createFirst[1]).toBe(true);
      const delayedPurge = await pool.query<{
        deletedAt: Date;
        nextAttemptAt: Date;
      }>(
        `select
           parent.deleted_at as "deletedAt",
           event.next_attempt_at as "nextAttemptAt"
         from ${lockTable} parent
         join outbox event on event.topic = $1
         where parent.id = $2`,
        [`${parent}.purge`, parentId],
      );
      const purge = delayedPurge.rows.at(0);
      expect(purge?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
        (purge?.deletedAt.getTime() ?? 0) + 15 * 60 * 1_000,
      );
      expect(purge?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

      await pool.query(
        'TRUNCATE outbox, assets, conversations, accounts CASCADE',
      );
      const deleteFirst = await run('delete', lateAssetId);
      expect(deleteFirst).toEqual([null, true]);
      await expect(
        pool.query<{ count: number }>(
          'select count(*)::integer as count from assets where id = $1',
          [lateAssetId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    },
    30_000,
  );
});

const insertAccountAndConversation = async (
  pool: Pool,
  conversationId: string,
  deletedAt: Date | null,
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO accounts (id, display_name)
      VALUES ($1, 'Asset integrity account')
    `,
    [accountId],
  );
  await pool.query(
    `
      INSERT INTO conversations (id, account_id, title, deleted_at)
      VALUES ($1, $2, 'Asset integrity conversation', $3)
    `,
    [conversationId, accountId, deletedAt],
  );
};

const insertAsset = async (
  pool: Pool,
  assetId: string,
  createdAt: Date,
  conversationId = activeConversationId,
): Promise<void> => {
  await pool.query(
    `
      INSERT INTO assets (
        id, account_id, conversation_id, status, original_key, content_type,
        byte_size, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'pending_upload', 'non-deterministic-key', 'image/jpeg', 128, $4, $4)
    `,
    [assetId, accountId, conversationId, createdAt],
  );
};
