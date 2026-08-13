import type { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment.js';

export type StorageBucket = 'raw' | 'normalized' | 'archive';

export type StorageBuckets = Readonly<Record<StorageBucket, string>>;

const configuredBucket = (
  value: string | undefined,
  fallback: string,
): string => {
  const configured = value?.trim();
  return configured && configured.length > 0 ? configured : fallback;
};

export const storageBucketsFromConfig = (
  config: ConfigService<Environment, true>,
): StorageBuckets => {
  const fallback = config.get('ASSET_BUCKET', { infer: true });
  return {
    raw: configuredBucket(
      config.get('RAW_ASSET_BUCKET', { infer: true }),
      fallback,
    ),
    normalized: configuredBucket(
      config.get('NORMALIZED_ASSET_BUCKET', { infer: true }),
      fallback,
    ),
    archive: configuredBucket(
      config.get('ARCHIVE_BUCKET', { infer: true }),
      fallback,
    ),
  };
};
