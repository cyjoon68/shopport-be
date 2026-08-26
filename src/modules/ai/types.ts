import type { ProductGraphql } from '../catalog/catalog.mapper.js';
import type { AiProviderId } from './ai-request.js';

export const clarificationDimensions = [
  'purpose',
  'budget',
  'requirement',
] as const;

export type ClarificationDimension = (typeof clarificationDimensions)[number];

export type AiHistoryMessage = Readonly<{
  role: 'user' | 'assistant';
  text: string;
}>;

export type AskUser = Readonly<{
  dimension: ClarificationDimension;
  question: string;
  options: ReadonlyArray<Readonly<{ id: string; label: string }>>;
  allowFreeText: boolean;
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

export type PersistedProductRecommendation = AiProductRecommendation &
  Readonly<{ productSnapshot: ProductGraphql | null }>;

export type CompleteRunInput = Readonly<{
  runId: string;
  conversationId: string;
  messageId: string;
  text: string;
  productRecommendations: ReadonlyArray<PersistedProductRecommendation>;
  askUser: AskUser | null;
  providerIds: ReadonlyArray<AiProviderId>;
}>;
