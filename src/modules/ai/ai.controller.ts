import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { resumeHttpResponse, toHttpResponse } from '@tanstack/ai';
import type { Response as ExpressResponse } from 'express';
import { z } from 'zod';

import type { RedisClient } from '../../redis/redis.module.js';
import { REDIS } from '../../redis/redis.module.js';
import { type AuthenticatedRequest, viewerIdFrom } from '../auth/auth.guard.js';
import { AiAccessError } from './ai.errors.js';
import { AiService } from './ai.service.js';
import {
  AiRequestValidationError,
  parseRunReference,
  runIdSchema,
  storageRunIdFor,
} from './ai-request.js';
import { RedisStreamDurability } from './redis-stream-durability.js';

const resumeQuerySchema = z.object({
  runId: runIdSchema,
  offset: z.string().min(1),
});

const cancelSchema = z.strictObject({
  threadId: z.uuid(),
  runId: runIdSchema,
});

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
  for await (const chunk of source.body) target.write(Buffer.from(chunk));
  target.end();
};

const accessError = (error: AiAccessError): HttpException =>
  new HttpException(
    { code: error.code, message: error.message },
    error.code === 'QUOTA_EXCEEDED'
      ? HttpStatus.TOO_MANY_REQUESTS
      : HttpStatus.PAYMENT_REQUIRED,
  );

@Controller('v1/ai/chat')
export class AiController {
  public constructor(
    private readonly ai: AiService,
    @Inject(REDIS) private readonly redis: RedisClient,
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
      const offset = request.header('last-event-id') ?? null;
      if (offset !== null) {
        await this.ai.assertOwnedRun(
          viewerIdFrom(request),
          reference.storageRunId,
          reference.threadId,
        );
      }
      const durability = new RedisStreamDurability(
        this.redis,
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
      if (error instanceof AiAccessError) throw accessError(error);
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
    const durability = new RedisStreamDurability(
      this.redis,
      storageRunId,
      request.header('last-event-id') ?? parsed.data.offset,
    );
    await pipeResponse(resumeHttpResponse({ adapter: durability }), response);
  }

  @Post('cancel')
  @HttpCode(204)
  public async cancel(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = cancelSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Invalid cancel request');
    await this.ai.cancel(
      viewerIdFrom(request),
      parsed.data.threadId,
      parsed.data.runId,
    );
  }
}
