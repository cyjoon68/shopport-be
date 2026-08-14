import { describe, expect, it } from '@jest/globals';
import type { CatalogService } from '../catalog/catalog.service.js';
import { mapMessages } from './message.mapper.js';

describe('mapMessages', () => {
  it('restores an archived ask_user part for the GraphQL union', async () => {
    const messages = await mapMessages(
      [
        {
          id: '0198a122-0c00-7000-8000-000000000011',
          conversationId: '0198a122-0c00-7000-8000-000000000010',
          role: 'assistant',
          status: 'completed',
          createdAt: new Date('2026-08-14T00:00:00Z'),
        },
      ],
      [
        {
          id: '0198a122-0c00-7000-8000-000000000012',
          messageId: '0198a122-0c00-7000-8000-000000000011',
          kind: 'ask_user',
          position: 0,
          payload: {
            question: '예산은 어느 정도인가요?',
            options: [
              { id: 'under-3', label: '3만원 이하' },
              { id: 'under-5', label: '5만원 이하' },
            ],
            allowFreeText: true,
          },
        },
      ],
      {} as CatalogService,
    );
    expect(messages[0]?.parts).toEqual([
      {
        __typename: 'AskUserMessagePart',
        id: '0198a122-0c00-7000-8000-000000000012',
        question: '예산은 어느 정도인가요?',
        options: [
          { id: 'under-3', label: '3만원 이하' },
          { id: 'under-5', label: '5만원 이하' },
        ],
        allowFreeText: true,
      },
    ]);
  });
});
