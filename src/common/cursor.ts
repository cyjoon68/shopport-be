import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const cursorPayloadSchema = z.strictObject({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
});
const pageCursorSchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform(Number)
  .refine(Number.isSafeInteger);

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;

const invalidCursor = (): never => {
  throw new BadRequestException('Invalid cursor');
};

const decodeBase64url = (cursor: string): string => {
  if (!/^[A-Za-z0-9_-]*$/u.test(cursor)) return invalidCursor();
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.toString('base64url') !== cursor) return invalidCursor();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch {
    return invalidCursor();
  }
};

export const encodeCursor = (payload: CursorPayload): string =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

export const decodeCursor = (cursor: string | null): CursorPayload | null => {
  if (cursor === null) return null;
  try {
    const parsed = cursorPayloadSchema.safeParse(
      JSON.parse(decodeBase64url(cursor)),
    );
    return parsed.success ? parsed.data : invalidCursor();
  } catch {
    return invalidCursor();
  }
};

export const encodePageCursor = (page: number): string =>
  Buffer.from(String(page), 'utf8').toString('base64url');

export const decodePageCursor = (cursor: string | null): number => {
  if (cursor === null) return 1;
  const parsed = pageCursorSchema.safeParse(decodeBase64url(cursor));
  return parsed.success ? parsed.data : invalidCursor();
};
