import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getCloudFrontSignedUrl } from '@aws-sdk/cloudfront-signer';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';

import type { Environment } from '../../config/environment.js';
import { storageBucketsFromConfig } from '../../storage/storage-buckets.js';
import type { AssetRecord } from './assets.repository.js';
import { AssetsRepository } from './assets.repository.js';

const localCredentials = {
  accessKeyId: 'test',
  secretAccessKey: 'test',
};
const maxAiImageBytes = 10 * 1024 * 1024;

export type AssetGraphql = Readonly<{
  id: string;
  status: string;
  url: string | null;
  width: number | null;
  height: number | null;
  createdAt: Date;
}>;

export type AssetUploadGraphql = Readonly<{
  asset: AssetGraphql;
  uploadUrl: string;
  headers: ReadonlyArray<Readonly<{ name: string; value: string }>>;
}>;

@Injectable()
export class AssetsService {
  readonly #s3: S3Client;
  readonly #rawBucket: string;
  readonly #normalizedBucket: string;

  public constructor(
    private readonly repository: AssetsRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {
    const endpoint = config.get('AWS_ENDPOINT_URL', { infer: true });
    const buckets = storageBucketsFromConfig(config);
    this.#rawBucket = buckets.raw;
    this.#normalizedBucket = buckets.normalized;
    this.#s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      ...(endpoint
        ? { endpoint, forcePathStyle: true, credentials: localCredentials }
        : {}),
    });
  }

  public createUpload = async (input: {
    accountId: string;
    conversationId: string;
    contentType: string;
    byteSize: number;
  }): Promise<AssetUploadGraphql> => {
    if (
      !(await this.repository.ownsConversation(
        input.accountId,
        input.conversationId,
      ))
    ) {
      throw new NotFoundException('Conversation not found');
    }
    const id = uuidv7();
    const originalKey = `uploads/${input.accountId}/${id}/original`;
    const asset = await this.repository.create({ ...input, id, originalKey });
    const uploadUrl = await getSignedUrl(
      this.#s3,
      new PutObjectCommand({
        Bucket: this.#rawBucket,
        Key: originalKey,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
      }),
      { expiresIn: 10 * 60 },
    );
    return {
      asset: this.toGraphql(asset),
      uploadUrl,
      headers: [{ name: 'content-type', value: input.contentType }],
    };
  };

  public find = async (
    accountId: string,
    id: string,
  ): Promise<AssetGraphql | null> => {
    const asset = await this.repository.findOwned(accountId, id);
    return asset ? this.toGraphql(asset) : null;
  };

  public delete = (accountId: string, id: string): Promise<boolean> =>
    this.repository.delete(accountId, id);

  public readNormalizedImage = async (
    accountId: string,
    id: string,
  ): Promise<Readonly<{ base64: string; mimeType: 'image/jpeg' }>> => {
    const asset = await this.repository.findOwned(accountId, id);
    if (asset?.status !== 'ready' || !asset.normalizedKey) {
      throw new NotFoundException('Ready image asset not found');
    }
    const object = await this.#s3.send(
      new GetObjectCommand({
        Bucket: this.#normalizedBucket,
        Key: asset.normalizedKey,
      }),
    );
    if (!object.Body) throw new Error('Normalized image has no body');
    const bytes = await object.Body.transformToByteArray();
    if (bytes.byteLength > maxAiImageBytes) {
      throw new Error('Normalized image exceeds AI provider limit');
    }
    return {
      base64: Buffer.from(bytes).toString('base64'),
      mimeType: 'image/jpeg',
    };
  };

  private readonly toGraphql = (asset: AssetRecord): AssetGraphql => ({
    id: asset.id,
    status: asset.status.toUpperCase(),
    url: asset.normalizedKey ? this.signedAssetUrl(asset.normalizedKey) : null,
    width: asset.width,
    height: asset.height,
    createdAt: asset.createdAt,
  });

  private readonly signedAssetUrl = (key: string): string => {
    const url = `https://${this.config.get('ASSET_CDN_HOST', { infer: true })}/${key}`;
    const keyPairId = this.config.get('CLOUDFRONT_KEY_PAIR_ID', {
      infer: true,
    });
    const privateKey = this.config.get('CLOUDFRONT_PRIVATE_KEY', {
      infer: true,
    });
    if (!keyPairId || !privateKey) return url;
    return getCloudFrontSignedUrl({
      url,
      keyPairId,
      privateKey: privateKey.replaceAll('\\n', '\n'),
      dateLessThan: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
    });
  };
}
