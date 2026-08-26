import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment.js';
import { ObjectStore } from './object-store.js';

const config = new ConfigService<Environment, true>({
  ASSET_BUCKET: 'shopport-assets',
  AWS_REGION: 'ap-northeast-2',
});

describe('object store cleanup', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats a missing bucket as an already-cleaned target', async () => {
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(() => {
        throw Object.assign(new Error('The specified bucket does not exist'), {
          name: 'NoSuchBucket',
        });
      });
    const store = new ObjectStore(config);

    await expect(
      store.deleteKey('raw', 'uploads/account/asset'),
    ).resolves.toBeUndefined();
    await expect(
      store.deletePrefix('raw', 'uploads/account/'),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects a partial prefix deletion without exposing object keys', async () => {
    jest
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation((command: unknown) => {
        if (command instanceof ListObjectsV2Command) {
          return Promise.resolve({
            Contents: [
              { Key: 'uploads/private-account/asset/original' },
              { Key: 'uploads/private-account/asset/normalized.jpg' },
            ],
          }) as never;
        }
        if (command instanceof DeleteObjectsCommand) {
          return Promise.resolve({
            Errors: [
              {
                Code: 'AccessDenied',
                Key: 'uploads/private-account/asset/original',
              },
              {
                Code: 'InternalError',
                Key: 'uploads/private-account/asset/normalized.jpg',
              },
            ],
          }) as never;
        }
        throw new Error('Unexpected S3 command');
      });
    const store = new ObjectStore(config);

    await expect(
      store.deletePrefix('raw', 'uploads/private-account/'),
    ).rejects.toThrow(
      'S3 multi-delete failed: count=2 codes=AccessDenied,InternalError',
    );
    await expect(
      store.deletePrefix('raw', 'uploads/private-account/'),
    ).rejects.not.toThrow(/private-account|asset|original|normalized/u);
  });
});
