import { Injectable } from '@nestjs/common';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
} from './ai-stream.adapter.js';
import type { AiToolSession } from './ai-tools.js';
import { createFakeAiStream } from './fake-ai.stream.js';

@Injectable()
export class FakeAiStreamAdapter implements AiStreamAdapter {
  public readonly requiresImageData = false;

  public createStream = (
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): ReturnType<AiStreamAdapter['createStream']> =>
    createFakeAiStream(input, tools, lifecycle);
}
