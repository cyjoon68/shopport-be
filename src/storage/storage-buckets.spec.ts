import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment.js';
import { storageBucketsFromConfig } from './storage-buckets.js';

describe('storage bucket resolution', () => {
  it('uses split buckets when configured', () => {
    const buckets = storageBucketsFromConfig(
      new ConfigService<Environment, true>({
        ASSET_BUCKET: 'legacy',
        RAW_ASSET_BUCKET: 'raw',
        NORMALIZED_ASSET_BUCKET: 'normalized',
        ARCHIVE_BUCKET: 'archive',
      }),
    );

    expect(buckets).toEqual({
      raw: 'raw',
      normalized: 'normalized',
      archive: 'archive',
    });
  });

  it('keeps the legacy bucket fallback for local development', () => {
    const buckets = storageBucketsFromConfig(
      new ConfigService<Environment, true>({ ASSET_BUCKET: 'local-assets' }),
    );

    expect(buckets).toEqual({
      raw: 'local-assets',
      normalized: 'local-assets',
      archive: 'local-assets',
    });
  });
});
