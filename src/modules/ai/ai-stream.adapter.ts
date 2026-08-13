import type { StreamChunk } from '@tanstack/ai';
import type { ProductGraphql } from '../catalog/catalog.mapper.js';

export const AI_STREAM_ADAPTER = Symbol('AI_STREAM_ADAPTER');

export type AiStreamInput = Readonly<{
  threadId: string;
  runId: string;
  messageId: string;
  message: string;
  products: ReadonlyArray<ProductGraphql>;
}>;

export type AiStreamLifecycle = Readonly<{
  onComplete: () => Promise<void>;
  onFailure: () => Promise<void>;
  isCancelled: () => Promise<boolean>;
}>;

export interface AiStreamAdapter {
  createStream(
    input: AiStreamInput,
    lifecycle: AiStreamLifecycle,
  ): AsyncIterable<StreamChunk>;
}
