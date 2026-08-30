import { describe, expect, it, jest } from '@jest/globals';
import type { Response as ExpressResponse } from 'express';
import type { Pool } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AiController } from './ai.controller.js';
import type { AiService } from './ai.service.js';

const invalidOffsets = ['-1', '42-0', '+1', '1.5', '9223372036854775808'];

const fixture = (
  offset: string,
): Readonly<{
  controller: AiController;
  request: AuthenticatedRequest;
  response: ExpressResponse;
}> => {
  const ai = {
    assertOwnedRun: jest.fn(() => Promise.resolve()),
  } as unknown as AiService;
  const pool = {
    query: jest.fn(() => Promise.reject(new Error('database reached'))),
  } as unknown as Pool;
  const request = {
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'last-event-id' ? offset : undefined,
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
    request,
    response,
  };
};

describe('AiController replay offsets', () => {
  it.each(invalidOffsets)(
    'rejects GET offset %s at the boundary',
    async (offset) => {
      const { controller, request, response } = fixture('unused');

      await expect(
        controller.resume(request, { runId: uuidv7(), offset }, response),
      ).rejects.toThrow('Invalid replay request');
    },
  );

  it.each(invalidOffsets)(
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
