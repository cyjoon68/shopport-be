import { z } from 'zod';

const cursorPayloadSchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

export const encodeCursor = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodeCursor = (cursor: string | null): CursorPayload | null => {
  if (cursor === null) return null;
  try {
    return cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    return null;
  }
};
