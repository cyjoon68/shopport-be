import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';

const runIdNamespace = '00000000-0000-4000-8000-000000000001';

export const providerIdsSchema = z
  .array(z.enum(['daiso', 'oliveyoung']))
  .max(2)
  .refine(
    (value) => new Set(value).size === value.length,
    'Provider IDs must be unique',
  );

export type AiProviderId = z.infer<typeof providerIdsSchema>[number];

export const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\r\n]/u.test(value), 'Invalid run ID');

export const storageRunIdFor = (runId: string): string =>
  z.uuid().safeParse(runId).success ? runId : uuidv5(runId, runIdNamespace);

const messageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant', 'tool', 'reasoning']),
  content: z.unknown().optional(),
});

const bodySchema = z.looseObject({
  threadId: z.uuid(),
  runId: runIdSchema,
  messages: z.array(messageSchema).min(1),
  forwardedProps: z.record(z.string(), z.unknown()).default({}),
});

export type AiRequest = Readonly<{
  threadId: string;
  runId: string;
  storageRunId: string;
  userMessageId: string;
  text: string;
  assetId: string | null;
  providerIds: ReadonlyArray<AiProviderId>;
  providerIdsSpecified: boolean;
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
  const userMessageId = z.uuidv7().parse(userMessage.id);
  const assetIdValue = parsed.forwardedProps.assetId;
  const assetId =
    assetIdValue === undefined || assetIdValue === null
      ? null
      : z.uuid().parse(assetIdValue);
  const providerIdsValue = parsed.forwardedProps.providerIds;
  const providerIds =
    providerIdsValue === undefined
      ? []
      : providerIdsSchema.parse(providerIdsValue);
  const text = textFromContent(userMessage.content);
  if (text.length > 2_000) {
    throw new AiRequestValidationError('User message exceeds 2000 chars');
  }
  const request = {
    threadId: parsed.threadId,
    runId: parsed.runId,
    storageRunId: storageRunIdFor(parsed.runId),
    userMessageId,
    text,
    assetId,
    providerIds,
    providerIdsSpecified: providerIdsValue !== undefined,
  };
  if (request.text.length === 0 && request.assetId === null) {
    throw new AiRequestValidationError('AI turn requires text or one image');
  }
  return request;
};

export const parseRunReference = (
  body: unknown,
): Readonly<{ threadId: string; runId: string; storageRunId: string }> => {
  const parsed = bodySchema.pick({ threadId: true, runId: true }).parse(body);
  return {
    threadId: parsed.threadId,
    runId: parsed.runId,
    storageRunId: storageRunIdFor(parsed.runId),
  };
};
