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

const localCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };

@Injectable()
export class ObjectStore {
  readonly #s3: S3Client;
  readonly #bucket: string;

  public constructor(config: ConfigService<Environment, true>) {
    const endpoint = config.get('AWS_ENDPOINT_URL', { infer: true });
    this.#bucket = config.get('ASSET_BUCKET', { infer: true });
    this.#s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      ...(endpoint
        ? { endpoint, forcePathStyle: true, credentials: localCredentials }
        : {}),
    });
  }

  public put = async (
    key: string,
    body: Buffer,
    contentType: string,
    checksumSha256: string,
  ): Promise<void> => {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ChecksumSHA256: checksumSha256,
        ServerSideEncryption: 'aws:kms',
      }),
    );
  };

  public get = async (key: string): Promise<Buffer> => {
    const object = await this.#s3.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if (!object.Body) throw new Error(`S3 object has no body: ${key}`);
    return Buffer.from(await object.Body.transformToByteArray());
  };

  public deleteKey = async (key: string): Promise<void> => {
    await this.#s3.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
  };

  public deletePrefix = async (prefix: string): Promise<void> => {
    let continuationToken: string | undefined;
    do {
      const page = await this.#s3.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
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
        await this.#s3.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
  };
}
