import type { StreamChunk } from '@tanstack/ai';

import type { AiToolSession } from './ai-tools.js';
import type { AiStreamInput, AiStreamLifecycle } from './types.js';

export const AI_STREAM_ADAPTER = Symbol('AI_STREAM_ADAPTER');

export interface AiStreamAdapter {
  readonly requiresImageData: boolean;
  generateTitle(prompt: string): Promise<string>;
  createStream(
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk>;
}
