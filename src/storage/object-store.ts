import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment.js';
import type { StorageBucket, StorageBuckets } from './storage-buckets.js';
import { storageBucketsFromConfig } from './storage-buckets.js';

const localCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };

const isMissingBucketError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'NoSuchBucket';

const multiDeleteError = (
  errors: ReadonlyArray<Readonly<{ Code?: string | undefined }>>,
): Error => {
  const codes = [
    ...new Set(
      errors.map(({ Code }) =>
        Code && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(Code) ? Code : 'Unknown',
      ),
    ),
  ].slice(0, 5);
  return new Error(
    `S3 multi-delete failed: count=${String(errors.length)} codes=${codes.join(',')}`,
  );
};

@Injectable()
export class ObjectStore {
  readonly #s3: S3Client;
  readonly #buckets: StorageBuckets;

  public constructor(config: ConfigService<Environment, true>) {
    const endpoint = config.get('AWS_ENDPOINT_URL', { infer: true });
    this.#buckets = storageBucketsFromConfig(config);
    this.#s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      ...(endpoint
        ? { endpoint, forcePathStyle: true, credentials: localCredentials }
        : {}),
    });
  }

  public put = async (
    bucket: StorageBucket,
    key: string,
    body: Buffer,
    contentType: string,
    checksumSha256: string,
  ): Promise<void> => {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#buckets[bucket],
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: checksumSha256,
      }),
    );
  };

  public get = async (bucket: StorageBucket, key: string): Promise<Buffer> => {
    const object = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#buckets[bucket], Key: key }),
    );
    if (!object.Body) throw new Error('S3 object has no body');
    return Buffer.from(await object.Body.transformToByteArray());
  };

  public deleteKey = async (
    bucket: StorageBucket,
    key: string,
  ): Promise<void> => {
    try {
      await this.#s3.send(
        new DeleteObjectCommand({ Bucket: this.#buckets[bucket], Key: key }),
      );
    } catch (error) {
      if (!isMissingBucketError(error)) throw error;
    }
  };

  public deletePrefix = async (
    bucket: StorageBucket,
    prefix: string,
  ): Promise<void> => {
    try {
      let continuationToken: string | undefined;
      do {
        const page = await this.#s3.send(
          new ListObjectsV2Command({
            Bucket: this.#buckets[bucket],
            Prefix: prefix,
            ...(continuationToken
              ? { ContinuationToken: continuationToken }
              : {}),
          }),
        );
        const objects = (page.Contents ?? []).flatMap(({ Key }) =>
          Key ? [{ Key }] : [],
        );
        if (objects.length > 0) {
          const result = await this.#s3.send(
            new DeleteObjectsCommand({
              Bucket: this.#buckets[bucket],
              Delete: { Objects: objects, Quiet: true },
            }),
          );
          if (result.Errors?.length) throw multiDeleteError(result.Errors);
        }
        continuationToken = page.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      if (!isMissingBucketError(error)) throw error;
    }
  };
}
