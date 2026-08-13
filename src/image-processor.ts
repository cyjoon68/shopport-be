import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { S3Event, S3EventRecord } from 'aws-lambda';
import { z } from 'zod';
import { normalizeImage } from './modules/assets/normalize-image.js';

const environmentSchema = z.object({
  AWS_REGION: z.string().default('ap-northeast-2'),
  AWS_ENDPOINT_URL: z.url().optional(),
  SQS_ASSET_RESULT_URL: z.string().min(1),
});

const resultSchema = z.object({
  assetId: z.uuid(),
  bucket: z.string().min(1),
  normalizedKey: z.string().min(1).nullable(),
  status: z.enum(['ready', 'rejected']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  reason: z.string().nullable(),
});

const environment = environmentSchema.parse(process.env);
const localConfig = environment.AWS_ENDPOINT_URL
  ? {
      endpoint: environment.AWS_ENDPOINT_URL,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      forcePathStyle: true,
    }
  : {};
const s3 = new S3Client({ region: environment.AWS_REGION, ...localConfig });
const sqs = new SQSClient({ region: environment.AWS_REGION, ...localConfig });

const assetIdFrom = (key: string): string => {
  const segments = key.split('/');
  const id = segments.at(-2);
  return z.uuid().parse(id);
};

const sendResult = async (
  result: z.infer<typeof resultSchema>,
): Promise<void> => {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: environment.SQS_ASSET_RESULT_URL,
      MessageBody: JSON.stringify(resultSchema.parse(result)),
    }),
  );
};

const processRecord = async (record: S3EventRecord): Promise<void> => {
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replaceAll('+', ' '));
  const assetId = assetIdFrom(key);
  try {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!object.Body) throw new Error('Missing image body');
    const source = Buffer.from(await object.Body.transformToByteArray());
    const normalizedKey = key.replace(/\/original$/, '/normalized.jpg');
    const normalized = await normalizeImage(source);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: normalizedKey,
        Body: normalized.data,
        ContentType: 'image/jpeg',
        ServerSideEncryption: 'aws:kms',
      }),
    );
    await sendResult({
      assetId,
      bucket,
      normalizedKey,
      status: 'ready',
      width: normalized.width,
      height: normalized.height,
      reason: null,
    });
  } catch (error) {
    await sendResult({
      assetId,
      bucket,
      normalizedKey: null,
      status: 'rejected',
      width: null,
      height: null,
      reason:
        error instanceof Error ? error.message : 'Image processing failed',
    });
  }
};

export const handler = async (event: S3Event): Promise<void> => {
  await Promise.all(event.Records.map(processRecord));
};
