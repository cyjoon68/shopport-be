import { createHash } from 'node:crypto';

import { stripIgnoredCharacters } from 'graphql';

const hashPattern = /^[a-f\d]{64}$/u;
const invalidManifestMessage = 'Invalid persisted operation manifest';

export const hashGraphqlDocument = (document: string): string =>
  createHash('sha256').update(stripIgnoredCharacters(document)).digest('hex');

export const parsePersistedOperationManifest = (
  serialized: string,
): ReadonlyMap<string, string> => {
  if (serialized.trim().length === 0) return new Map();

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error(invalidManifestMessage);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(invalidManifestMessage);
  }

  const entries = Object.entries(parsed);
  for (const [hash, document] of entries) {
    if (!hashPattern.test(hash) || typeof document !== 'string') {
      throw new Error(invalidManifestMessage);
    }
    try {
      if (hashGraphqlDocument(document) !== hash) {
        throw new Error(invalidManifestMessage);
      }
    } catch {
      throw new Error(invalidManifestMessage);
    }
  }

  return new Map(entries as ReadonlyArray<readonly [string, string]>);
};
