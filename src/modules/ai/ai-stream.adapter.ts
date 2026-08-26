import type { StreamChunk } from '@tanstack/ai';

import type { AiProviderId } from './ai-request.js';
import type { AiToolSession } from './ai-tools.js';
import type { AiHistoryMessage, AiStreamResult } from './types.js';

export {
  clarificationDimensions,
  type AiHistoryMessage,
  type AiProductRecommendation,
  type AiStreamResult,
  type AskUser,
  type ClarificationDimension,
} from './types.js';

export const AI_STREAM_ADAPTER = Symbol('AI_STREAM_ADAPTER');

export type AiStreamInput = Readonly<{
  threadId: string;
  runId: string;
  text: string;
  providerIds?: ReadonlyArray<AiProviderId>;
  history?: ReadonlyArray<AiHistoryMessage>;
  image: Readonly<{ base64: string; mimeType: string }> | null;
}>;

export type AiStreamLifecycle = Readonly<{
  onComplete: (result: AiStreamResult) => Promise<void>;
  onFailure: () => Promise<void>;
  isCancelled: () => Promise<boolean>;
  renewLease: () => Promise<void>;
}>;

export interface AiStreamAdapter {
  readonly requiresImageData: boolean;
  generateTitle(prompt: string): Promise<string>;
  createStream(
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk>;
}
