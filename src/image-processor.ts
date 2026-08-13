import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import { z } from 'zod';
import {
  assetResultSchema,
  type AssetResult,
} from './modules/assets/asset-result.js';
import { normalizeImage } from './modules/assets/normalize-image.js';

const environmentSchema = z.object({
  AWS_REGION: z.string().default('ap-northeast-2'),
  AWS_ENDPOINT_URL: z.url().optional(),
  ASSET_BUCKET: z.string().default('shopport-assets'),
  NORMALIZED_ASSET_BUCKET: z.string().optional(),
  SQS_ASSET_RESULT_URL: z.string().min(1),
});

type NormalizedImage = Readonly<{
  data: Buffer;
  width: number;
  height: number;
}>;

type ImageProcessorDependencies = Readonly<{
  normalizedBucket: string;
  getRawObject: (bucket: string, key: string) => Promise<Buffer>;
  putNormalizedObject: (
    bucket: string,
    key: string,
    body: Buffer,
  ) => Promise<void>;
  normalize: (source: Buffer) => Promise<NormalizedImage>;
  sendResult: (result: AssetResult) => Promise<void>;
}>;

const assetIdFrom = (key: string): string => {
  const segments = key.split('/');
  const id = segments.at(-2);
  return z.uuid().parse(id);
};

const processRecord = async (
  record: S3EventRecord,
  dependencies: ImageProcessorDependencies,
): Promise<void> => {
  const rawBucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replaceAll('+', ' '));
  const assetId = assetIdFrom(key);
  try {
    const source = await dependencies.getRawObject(rawBucket, key);
    const normalizedKey = key.replace(/\/original$/u, '/normalized.jpg');
    const normalized = await dependencies.normalize(source);
    await dependencies.putNormalizedObject(
      dependencies.normalizedBucket,
      normalizedKey,
      normalized.data,
    );
    await dependencies.sendResult({
      assetId,
      normalizedKey,
      status: 'ready',
      width: normalized.width,
      height: normalized.height,
    });
  } catch {
    await dependencies.sendResult({
      assetId,
      normalizedKey: null,
      status: 'rejected',
      width: null,
      height: null,
    });
  }
};

export const processImageEvent = async (
  event: S3Event,
  dependencies: ImageProcessorDependencies,
): Promise<void> => {
  await Promise.all(
    event.Records.map((record) => processRecord(record, dependencies)),
  );
};

const createRuntime = (): ImageProcessorDependencies => {
  const environment = environmentSchema.parse(process.env);
  const configuredNormalizedBucket =
    environment.NORMALIZED_ASSET_BUCKET?.trim();
  const localConfig = environment.AWS_ENDPOINT_URL
    ? {
        endpoint: environment.AWS_ENDPOINT_URL,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        forcePathStyle: true,
      }
    : {};
  const s3 = new S3Client({ region: environment.AWS_REGION, ...localConfig });
  const sqs = new SQSClient({ region: environment.AWS_REGION, ...localConfig });
  return {
    normalizedBucket:
      configuredNormalizedBucket && configuredNormalizedBucket.length > 0
        ? configuredNormalizedBucket
        : environment.ASSET_BUCKET,
    getRawObject: async (bucket, key): Promise<Buffer> => {
      const object = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      if (!object.Body) throw new Error('Missing image body');
      return Buffer.from(await object.Body.transformToByteArray());
    },
    putNormalizedObject: async (bucket, key, body): Promise<void> => {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'image/jpeg',
        }),
      );
    },
    normalize: normalizeImage,
    sendResult: async (result): Promise<void> => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: environment.SQS_ASSET_RESULT_URL,
          MessageBody: JSON.stringify(assetResultSchema.parse(result)),
        }),
      );
    },
  };
};

let runtime: ImageProcessorDependencies | undefined;

export const handler = async (event: S3Event): Promise<void> => {
  runtime ??= createRuntime();
  await processImageEvent(event, runtime);
};
