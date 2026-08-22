import type { StreamChunk } from '@tanstack/ai';
import type { AiToolSession } from './ai-tools.js';

export const AI_STREAM_ADAPTER = Symbol('AI_STREAM_ADAPTER');

export type AiHistoryMessage = Readonly<{
  role: 'user' | 'assistant';
  text: string;
}>;

export type AskUser = Readonly<{
  question: string;
  options: ReadonlyArray<Readonly<{ id: string; label: string }>>;
  allowFreeText: boolean;
}>;

export type AiStreamInput = Readonly<{
  threadId: string;
  runId: string;
  text: string;
  history?: ReadonlyArray<AiHistoryMessage>;
  image: Readonly<{ base64: string; mimeType: string }> | null;
}>;

export type AiProductRecommendation = Readonly<{
  productId: string;
  aiSummary: string;
}>;

export type AiStreamResult = Readonly<{
  messageId: string;
  text: string;
  productRecommendations: ReadonlyArray<AiProductRecommendation>;
  askUser: AskUser | null;
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
