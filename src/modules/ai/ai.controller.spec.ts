import { describe, expect, it, jest } from '@jest/globals';
import type { Response as ExpressResponse } from 'express';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AiController } from './ai.controller.js';
import type { AiService } from './ai.service.js';

const invalidOffsets = ['-2', '42-0', '+1', '1.5', '9223372036854775808'];
const invalidHeaderOffsets = ['-1', ...invalidOffsets];

type Query = (
  text: string,
  values?: Array<unknown>,
) => Promise<{ rows: Array<unknown> }>;

const fixture = (
  headerOffset?: string,
): Readonly<{
  controller: AiController;
  query: jest.MockedFunction<Query>;
  request: AuthenticatedRequest;
  response: ExpressResponse;
}> => {
  const ai = {
    assertOwnedRun: jest.fn(() => Promise.resolve()),
  } as unknown as AiService;
  const query = jest.fn<Query>(() =>
    Promise.reject(new Error('database reached')),
  );
  const pool = { query } as unknown as Pool;
  const request = {
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'last-event-id' ? headerOffset : undefined,
    user: { sub: uuidv7(), sessionId: uuidv7() },
  } as unknown as AuthenticatedRequest;
  const response = {
    destroyed: false,
    end: jest.fn(),
    off: jest.fn(),
    once: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn(),
    writableEnded: false,
    write: jest.fn(() => true),
  } as unknown as ExpressResponse;
  return {
    controller: new AiController(ai, pool),
    query,
    request,
    response,
  };
};

describe('AiController replay offsets', () => {
  it('starts an initial GET replay after cursor zero', async () => {
    const { controller, query, request, response } = fixture();
    const runId = uuidv7();

    await expect(
      controller.resume(request, { runId, offset: '-1' }, response),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('id > $2'), [
      runId,
      '0',
      128,
    ]);
  });

  it('keeps a valid GET Last-Event-ID ahead of the query offset', async () => {
    const { controller, query, request, response } = fixture('7');
    const runId = uuidv7();

    await expect(
      controller.resume(request, { runId, offset: '-1' }, response),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('id > $2'), [
      runId,
      '7',
      128,
    ]);
  });

  it.each(invalidOffsets)(
    'rejects GET offset %s at the boundary',
    async (offset) => {
      const { controller, request, response } = fixture();

      await expect(
        controller.resume(request, { runId: uuidv7(), offset }, response),
      ).rejects.toThrow('Invalid replay request');
    },
  );

  it.each(invalidHeaderOffsets)(
    'rejects GET Last-Event-ID %s ahead of a valid query offset',
    async (offset) => {
      const { controller, request, response } = fixture(offset);

      await expect(
        controller.resume(request, { runId: uuidv7(), offset: '0' }, response),
      ).rejects.toThrow('Invalid replay request');
    },
  );

  it.each(invalidHeaderOffsets)(
    'rejects POST Last-Event-ID %s at the boundary',
    async (offset) => {
      const { controller, request, response } = fixture(offset);

      await expect(
        controller.chat(
          request,
          {
            threadId: uuidv7(),
            runId: uuidv7(),
            messages: [
              { id: uuidv7(), role: 'user', content: 'resume request' },
            ],
            forwardedProps: {},
          },
          response,
        ),
      ).rejects.toThrow('Invalid replay request');
    },
  );
});

describe('AiController cancellation', () => {
  it('returns the cancellation outcome', async () => {
    const { request } = fixture('unused');
    const cancel = jest
      .fn<
        (
          accountId: string,
          conversationId: string,
          runId: string,
        ) => Promise<'completed'>
      >()
      .mockResolvedValue('completed');
    const controller = new AiController(
      { cancel } as unknown as AiService,
      {} as Pool,
    );
    const accountId = request.user?.sub;
    if (accountId === undefined) throw new Error('Expected authenticated user');
    const threadId = uuidv7();
    const runId = uuidv7();

    await expect(
      controller.cancel(request, { threadId, runId }),
    ).resolves.toEqual({
      outcome: 'completed',
    });
    expect(cancel).toHaveBeenCalledWith(accountId, threadId, runId);
  });
});
