import type { S3Event } from 'aws-lambda';
import { v7 as uuidv7 } from 'uuid';

import { processImageEvent } from './image-processor.js';
import type { AssetResult } from './modules/assets/asset-result.js';

describe('image processor bucket contract', () => {
  it('reads the raw event object and writes only to the normalized bucket', async () => {
    const assetId = uuidv7();
    const rawBucket = 'shopport-raw';
    const normalizedBucket = 'shopport-normalized';
    const originalKey = `uploads/account/${assetId}/original`;
    const reads: Array<readonly [string, string]> = [];
    const writes: Array<readonly [string, string, Buffer]> = [];
    const results: Array<AssetResult> = [];
    const event = {
      Records: [
        {
          s3: {
            bucket: { name: rawBucket },
            object: { key: originalKey },
          },
        },
      ],
    } as S3Event;

    await processImageEvent(event, {
      normalizedBucket,
      getRawObject: (bucket, key): Promise<Buffer> => {
        reads.push([bucket, key]);
        return Promise.resolve(Buffer.from('raw-image'));
      },
      putNormalizedObject: (bucket, key, body): Promise<void> => {
        writes.push([bucket, key, body]);
        return Promise.resolve();
      },
      normalize: () =>
        Promise.resolve({
          data: Buffer.from('normalized-image'),
          width: 640,
          height: 480,
        }),
      sendResult: (result): Promise<void> => {
        results.push(result);
        return Promise.resolve();
      },
    });

    expect(reads).toEqual([[rawBucket, originalKey]]);
    expect(writes).toEqual([
      [
        normalizedBucket,
        `uploads/account/${assetId}/normalized.jpg`,
        Buffer.from('normalized-image'),
      ],
    ]);
    expect(writes.some(([bucket]) => bucket === rawBucket)).toBe(false);
    expect(results).toEqual([
      {
        assetId,
        normalizedKey: `uploads/account/${assetId}/normalized.jpg`,
        status: 'ready',
        width: 640,
        height: 480,
      },
    ]);
  });
});
