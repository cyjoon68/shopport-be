import { z } from 'zod';

const messageSchema = z.looseObject({
  id: z.uuid(),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.unknown(),
});

const bodySchema = z.looseObject({
  threadId: z.uuid(),
  runId: z.uuid(),
  messages: z.array(messageSchema).min(1),
  forwardedProps: z.record(z.string(), z.unknown()).default({}),
});

export type AiRequest = Readonly<{
  threadId: string;
  runId: string;
  userMessageId: string;
  text: string;
  assetId: string | null;
}>;

export class AiRequestValidationError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!isRecord(part) || part.type !== 'text') return '';
      return typeof part.text === 'string' ? part.text : '';
    })
    .filter((text) => text.length > 0)
    .join('\n')
    .trim();
};

export const parseAiRequest = (body: unknown): AiRequest => {
  const parsed = bodySchema.parse(body);
  const userMessage = parsed.messages.at(-1);
  if (userMessage?.role !== 'user') {
    throw new AiRequestValidationError('AI turn must end with a user message');
  }
  const assetIdValue = parsed.forwardedProps.assetId;
  const assetId =
    assetIdValue === undefined || assetIdValue === null
      ? null
      : z.uuid().parse(assetIdValue);
  const text = textFromContent(userMessage.content);
  if (text.length > 2_000) {
    throw new AiRequestValidationError('User message exceeds 2000 chars');
  }
  const request = {
    threadId: parsed.threadId,
    runId: parsed.runId,
    userMessageId: userMessage.id,
    text,
    assetId,
  };
  if (request.text.length === 0 && request.assetId === null) {
    throw new AiRequestValidationError('AI turn requires text or one image');
  }
  return request;
};

export const parseRunReference = (
  body: unknown,
): Readonly<{ threadId: string; runId: string }> =>
  bodySchema.pick({ threadId: true, runId: true }).parse(body);
