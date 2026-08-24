import { createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gunzipSync, gzipSync } from 'node:zlib';

import { z } from 'zod';

const archiveRecordSchema = z.object({
  message: z.object({
    id: z.uuid(),
    conversationId: z.uuid(),
    role: z.string(),
    status: z.string(),
    createdAt: z.iso.datetime(),
  }),
  parts: z.array(
    z.object({
      id: z.uuid(),
      messageId: z.uuid(),
      kind: z.string(),
      position: z.number().int().nonnegative(),
      payload: z.unknown(),
    }),
  ),
});

export type ArchiveRecord = z.infer<typeof archiveRecordSchema>;

type EncodedArchive = Readonly<{ body: Buffer; checksum: string }>;

const checksumOf = (body: Buffer): Buffer =>
  createHash('sha256').update(body).digest();

const verifyChecksum = (body: Buffer, expectedChecksum: string): void => {
  const expected = Buffer.from(expectedChecksum, 'base64');
  const actual = checksumOf(body);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('Archive checksum mismatch');
  }
};

const parseArchive = (body: Buffer): ReadonlyArray<ArchiveRecord> =>
  body
    .toString('utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => archiveRecordSchema.parse(JSON.parse(line)));

const gunzipAsync = promisify(gunzip);

export const encodeArchive = (
  records: ReadonlyArray<ArchiveRecord>,
): EncodedArchive => {
  const ndjson = `${records.map((record) => JSON.stringify(archiveRecordSchema.parse(record))).join('\n')}\n`;
  const body = gzipSync(ndjson);
  return { body, checksum: checksumOf(body).toString('base64') };
};

export const decodeArchive = (
  body: Buffer,
  expectedChecksum: string,
): ReadonlyArray<ArchiveRecord> => {
  verifyChecksum(body, expectedChecksum);
  return parseArchive(gunzipSync(body));
};

export const decodeArchiveAsync = async (
  body: Buffer,
  expectedChecksum: string,
): Promise<ReadonlyArray<ArchiveRecord>> => {
  verifyChecksum(body, expectedChecksum);
  return parseArchive(await gunzipAsync(body));
};
