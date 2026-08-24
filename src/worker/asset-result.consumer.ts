import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';

import type { Environment } from '../config/environment.js';
import type { Database } from '../database/database.module.js';
import { DATABASE } from '../database/database.module.js';
import { assets } from '../database/schema.js';
import { assetResultSchema } from '../modules/assets/asset-result.js';

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
      try {
        const result = assetResultSchema.parse(JSON.parse(message.Body));
        await this.database
          .update(assets)
          .set({
            status: result.status,
            normalizedKey: result.normalizedKey,
            width: result.width,
            height: result.height,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(assets.id, result.assetId),
              eq(assets.status, 'pending_upload'),
            ),
          );
        await this.#sqs.send(
          new DeleteMessageCommand({
            QueueUrl: this.#queueUrl,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      } catch {
        continue;
      }
    }
    return received.length > 0;
  };
}
