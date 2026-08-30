import { once } from 'node:events';

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { resumeHttpResponse, toHttpResponse } from '@tanstack/ai';
import type { Response as ExpressResponse } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';

import { DATABASE_POOL } from '../../database/database.module.js';
import { type AuthenticatedRequest, viewerIdFrom } from '../auth/auth.guard.js';
import type { CancelRunResult } from './ai.repository.js';
import { AiService } from './ai.service.js';
import {
  AiRequestValidationError,
  parseRunReference,
  runIdSchema,
  storageRunIdFor,
} from './ai-request.js';
import {
  parseExternalReplayOffset,
  PostgresStreamDurability,
} from './postgres-stream-durability.js';

const resumeQuerySchema = z.object({
  runId: runIdSchema,
  offset: z.string().min(1),
});

const cancelSchema = z.strictObject({
  threadId: z.uuid(),
  runId: runIdSchema,
});

const replayOffsetFrom = (offset: string): string => {
  const parsed = parseExternalReplayOffset(offset);
  if (parsed === null) throw new BadRequestException('Invalid replay request');
  return parsed;
};

const pipeResponse = async (
  source: Response,
  target: ExpressResponse,
): Promise<void> => {
  target.status(source.status);
  source.headers.forEach((value, key) => target.setHeader(key, value));
  if (!source.body) {
    target.end();
    return;
  }
  const reader = source.body.getReader();
  const isClosed = (): boolean => target.destroyed || target.writableEnded;
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  target.once('close', cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || isClosed()) break;
      if (!target.write(Buffer.from(value)) && !isClosed())
        await Promise.race([once(target, 'drain'), once(target, 'close')]);
      if (isClosed()) break;
    }
  } finally {
    target.off('close', cancel);
    reader.releaseLock();
    if (!isClosed()) target.end();
  }
};

@Controller('v1/ai/chat')
export class AiController {
  public constructor(
    private readonly ai: AiService,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Post()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  public async chat(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    try {
      const reference = parseRunReference(body);
      const requestedOffset = request.header('last-event-id') ?? null;
      if (requestedOffset !== null) {
        await this.ai.assertOwnedRun(
          viewerIdFrom(request),
          reference.storageRunId,
          reference.threadId,
        );
      }
      const offset =
        requestedOffset === null ? null : replayOffsetFrom(requestedOffset);
      const durability = new PostgresStreamDurability(
        this.pool,
        reference.storageRunId,
        offset,
      );
      const result =
        offset === null
          ? toHttpResponse(await this.ai.start(viewerIdFrom(request), body), {
              durability: { adapter: durability },
              headers: { 'x-run-id': reference.runId },
            })
          : resumeHttpResponse({ adapter: durability });
      await pipeResponse(result, response);
    } catch (error) {
      if (
        error instanceof z.ZodError ||
        error instanceof AiRequestValidationError
      ) {
        throw new BadRequestException('Invalid AI request');
      }
      throw error;
    }
  }

  @Get()
  public async resume(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const parsed = resumeQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException('Invalid replay request');
    const storageRunId = storageRunIdFor(parsed.data.runId);
    await this.ai.assertOwnedRun(viewerIdFrom(request), storageRunId);
    const offset = replayOffsetFrom(
      request.header('last-event-id') ?? parsed.data.offset,
    );
    const durability = new PostgresStreamDurability(
      this.pool,
      storageRunId,
      offset,
    );
    await pipeResponse(resumeHttpResponse({ adapter: durability }), response);
  }

  @Post('cancel')
  @HttpCode(200)
  public async cancel(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Readonly<{ outcome: CancelRunResult }>> {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid cancel request');
    const outcome = await this.ai.cancel(
      viewerIdFrom(request),
      parsed.data.threadId,
      parsed.data.runId,
    );
    return { outcome };
  }
}
