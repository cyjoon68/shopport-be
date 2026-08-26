import { describe, expect, it } from '@jest/globals';

import type { Database } from '../../database/database.module.js';
import { AssetsRepository } from './assets.repository.js';

describe('AssetsRepository current history assets', () => {
  it('skips the database when either batch is empty', async () => {
    const repository = new AssetsRepository({
      select: () => {
        throw new Error('Database should not be queried');
      },
    } as unknown as Database);

    await expect(
      repository.findForConversations([], ['conversation-1']),
    ).resolves.toEqual([]);
    await expect(
      repository.findForConversations(['asset-1'], []),
    ).resolves.toEqual([]);
  });
});
