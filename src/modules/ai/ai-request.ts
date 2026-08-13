import { z } from 'zod';

const messageSchema = z.looseObject({
  id: z.string().min(1),
  role: z.string(),
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
  text: string;
  assetId: string | null;
}>;

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
  const userMessage = parsed.messages
    .toReversed()
    .find((message) => message.role === 'user');
  const assetIdValue = parsed.forwardedProps.assetId;
  const assetId = z.uuid().safeParse(assetIdValue);
  const request = {
    threadId: parsed.threadId,
    runId: parsed.runId,
    text: userMessage ? textFromContent(userMessage.content) : '',
    assetId: assetId.success ? assetId.data : null,
  };
  if (request.text.length === 0 && request.assetId === null) {
    throw new Error('AI turn requires text or one image');
  }
  return request;
};

export const parseRunId = (body: unknown): string =>
  bodySchema.pick({ runId: true }).parse(body).runId;
