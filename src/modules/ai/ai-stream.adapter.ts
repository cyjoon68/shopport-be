import type { StreamChunk } from '@tanstack/ai';
import type { AiToolSession } from './ai-tools.js';

export const AI_STREAM_ADAPTER = Symbol('AI_STREAM_ADAPTER');

export type AiStreamInput = Readonly<{
  threadId: string;
  runId: string;
  text: string;
  image: Readonly<{ base64: string; mimeType: string }> | null;
}>;

export type AiStreamResult = Readonly<{
  messageId: string;
  text: string;
  productIds: ReadonlyArray<string>;
}>;

export type AiStreamLifecycle = Readonly<{
  onComplete: (result: AiStreamResult) => Promise<void>;
  onFailure: () => Promise<void>;
  isCancelled: () => Promise<boolean>;
}>;

export interface AiStreamAdapter {
  readonly requiresImageData: boolean;
  createStream(
    input: AiStreamInput,
    tools: AiToolSession,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk>;
}
