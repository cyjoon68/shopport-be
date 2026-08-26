import { z } from 'zod';

export const assetKeysFor = (
  accountId: string,
  assetId: string,
): Readonly<{ original: string; normalized: string }> => ({
  original: `uploads/${accountId}/${assetId}/original`,
  normalized: `uploads/${accountId}/${assetId}/normalized.jpg`,
});

export const parseNormalizedAssetKey = (
  key: string,
  assetId: string,
): string => {
  const match = /^uploads\/([^/]+)\/([^/]+)\/normalized\.jpg$/u.exec(key);
  if (!match) throw new Error('Invalid normalized asset key');
  const accountId = z.uuid().parse(match[1]);
  if (z.uuid().parse(match[2]) !== z.uuid().parse(assetId)) {
    throw new Error('Normalized key does not belong to asset');
  }
  return accountId;
};
