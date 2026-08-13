import {
  Body,
  Controller,
  Get,
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
import type { Request, Response as ExpressResponse } from 'express';
import { z } from 'zod';
import { REDIS } from '../../redis/redis.module.js';
import type { RedisClient } from '../../redis/redis.module.js';
import { viewerIdFrom, type AuthenticatedRequest } from '../auth/auth.guard.js';
import { AiAccessError } from './ai.errors.js';
import { parseRunId } from './ai-request.js';
import { AiService } from './ai.service.js';
import { RedisStreamDurability } from './redis-stream-durability.js';

const resumeQuerySchema = z.object({
  runId: z.uuid(),
  offset: z.string().min(1),
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
    const runId = parseRunId(body);
    const offset = request.header('last-event-id') ?? null;
    const durability = new RedisStreamDurability(this.redis, runId, offset);
    try {
      const result =
        offset === null
          ? toHttpResponse(await this.ai.start(viewerIdFrom(request), body), {
              durability: { adapter: durability },
              headers: { 'x-run-id': runId },
            })
          : resumeHttpResponse({ adapter: durability });
      await pipeResponse(result, response);
    } catch (error) {
      if (error instanceof AiAccessError) throw accessError(error);
      throw error;
    }
  }

  @Get()
  public async resume(
    @Req() request: Request,
    @Query() query: unknown,
    @Res() response: ExpressResponse,
  ): Promise<void> {
    const parsed = resumeQuerySchema.parse(query);
    const durability = new RedisStreamDurability(
      this.redis,
      parsed.runId,
      request.header('last-event-id') ?? parsed.offset,
    );
    await pipeResponse(resumeHttpResponse({ adapter: durability }), response);
  }
}
