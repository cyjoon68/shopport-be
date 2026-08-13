import { Injectable } from '@nestjs/common';
import type {
  AiStreamAdapter,
  AiStreamInput,
  AiStreamLifecycle,
} from './ai-stream.adapter.js';
import { createFakeAiStream } from './fake-ai.stream.js';

@Injectable()
export class FakeAiStreamAdapter implements AiStreamAdapter {
  public createStream = (
    input: AiStreamInput,
    lifecycle: AiStreamLifecycle,
  ): ReturnType<AiStreamAdapter['createStream']> =>
    createFakeAiStream(
      input,
      lifecycle.onComplete,
      lifecycle.onFailure,
      lifecycle.isCancelled,
    );
}
