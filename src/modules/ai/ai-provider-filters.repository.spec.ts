import { describe, expect, it, jest } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import { AiRepository } from './ai.repository.js';

const askUser = {
  dimension: 'budget',
  question: '예산은 어느 정도인가요?',
  options: [
    { id: 'under-3', label: '3만원 이하' },
    { id: 'under-5', label: '5만원 이하' },
  ],
  allowFreeText: true,
} as const;

const repositoryFor = (database: Database): AiRepository =>
  new AiRepository(database);

describe('AiRepository provider filters', () => {
  it('stores selected providers only in the internal clarification payload', async () => {
    const returning = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([{ id: 'run-1' }]);
    const where = jest
      .fn<() => { returning: typeof returning }>()
      .mockReturnValue({ returning });
    const set = jest
      .fn<() => { where: typeof where }>()
      .mockReturnValue({ where });
    const update = jest
      .fn<() => { set: typeof set }>()
      .mockReturnValue({ set });
    const values = jest
      .fn<(value: unknown) => Promise<void>>()
      .mockResolvedValue();
    const insert = jest
      .fn<(table: unknown) => { values: typeof values }>()
      .mockReturnValue({ values });
    const transaction = { update, insert };
    const database = {
      transaction: (
        callback: (value: typeof transaction) => Promise<void>,
      ): Promise<void> => callback(transaction),
    } as unknown as Database;

    await repositoryFor(database).completeRun({
      runId: '0198a122-0c00-7000-8000-000000000002',
      conversationId: '0198a122-0c00-7000-8000-000000000003',
      messageId: '0198a122-0c00-7000-8000-000000000004',
      text: '',
      productRecommendations: [],
      askUser,
      providerIds: ['oliveyoung'],
    });

    expect(values.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({
        kind: 'ask_user',
        payload: expect.objectContaining({ providerIds: ['oliveyoung'] }),
      }),
    ]);
  });

  it('reads providers only from the latest assistant clarification', async () => {
    const latestLimit = jest
      .fn<() => Promise<Array<{ id: string }>>>()
      .mockResolvedValue([{ id: 'assistant-message' }]);
    const latestOrderBy = jest
      .fn<() => { limit: typeof latestLimit }>()
      .mockReturnValue({ limit: latestLimit });
    const latestWhere = jest
      .fn<() => { orderBy: typeof latestOrderBy }>()
      .mockReturnValue({ orderBy: latestOrderBy });
    const latestInnerJoin = jest
      .fn<() => { where: typeof latestWhere }>()
      .mockReturnValue({ where: latestWhere });
    const latestFrom = jest
      .fn<() => { innerJoin: typeof latestInnerJoin }>()
      .mockReturnValue({ innerJoin: latestInnerJoin });
    const payloadLimit = jest
      .fn<() => Promise<Array<{ payload: unknown }>>>()
      .mockResolvedValue([
        { payload: { providerIds: ['oliveyoung', 'daiso'] } },
      ]);
    const payloadWhere = jest
      .fn<() => { limit: typeof payloadLimit }>()
      .mockReturnValue({ limit: payloadLimit });
    const payloadFrom = jest
      .fn<() => { where: typeof payloadWhere }>()
      .mockReturnValue({ where: payloadWhere });
    const database = {
      select: jest
        .fn()
        .mockReturnValueOnce({ from: latestFrom })
        .mockReturnValueOnce({ from: payloadFrom }),
    } as unknown as Database;

    await expect(
      repositoryFor(database).pendingProviderIds(
        '0198a122-0c00-7000-8000-000000000005',
        '0198a122-0c00-7000-8000-000000000006',
      ),
    ).resolves.toEqual(['oliveyoung', 'daiso']);
  });
});
