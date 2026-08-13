import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Environment } from '../config/environment.js';
import { DATABASE } from '../database/database.module.js';
import type { Database } from '../database/database.module.js';
import { assets } from '../database/schema.js';

const resultSchema = z.object({
  assetId: z.uuid(),
  normalizedKey: z.string().min(1).nullable(),
  status: z.enum(['ready', 'rejected']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
});

const localCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };

@Injectable()
export class AssetResultConsumer {
  readonly #sqs: SQSClient;
  readonly #queueUrl: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    config: ConfigService<Environment, true>,
  ) {
    const endpoint = config.get('AWS_ENDPOINT_URL', { infer: true });
    this.#queueUrl = config.get('SQS_ASSET_RESULT_URL', { infer: true });
    this.#sqs = new SQSClient({
      region: config.get('AWS_REGION', { infer: true }),
      ...(endpoint ? { endpoint, credentials: localCredentials } : {}),
    });
  }

  public consume = async (): Promise<boolean> => {
    const response = await this.#sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.#queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
      }),
    );
    const received = response.Messages ?? [];
    for (const message of received) {
      if (!message.Body || !message.ReceiptHandle) continue;
      const result = resultSchema.parse(JSON.parse(message.Body));
      await this.database
        .update(assets)
        .set({
          status: result.status,
          normalizedKey: result.normalizedKey,
          width: result.width,
          height: result.height,
          updatedAt: new Date(),
        })
        .where(eq(assets.id, result.assetId));
      await this.#sqs.send(
        new DeleteMessageCommand({
          QueueUrl: this.#queueUrl,
          ReceiptHandle: message.ReceiptHandle,
        }),
      );
    }
    return received.length > 0;
  };
}
