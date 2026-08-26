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
import {
  assetKeysFor,
  parseNormalizedAssetKey,
} from '../modules/assets/keys.js';
import { ObjectStore } from '../storage/object-store.js';

const localCredentials = { accessKeyId: 'test', secretAccessKey: 'test' };

@Injectable()
export class AssetResultConsumer {
  readonly #sqs: SQSClient;
  readonly #queueUrl: string;

  public constructor(
    @Inject(DATABASE) private readonly database: Database,
    config: ConfigService<Environment, true>,
    private readonly objects: ObjectStore,
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
        const parsedAccountId =
          result.status === 'ready'
            ? parseNormalizedAssetKey(result.normalizedKey, result.assetId)
            : null;
        const owners = await this.database
          .select({ accountId: assets.accountId })
          .from(assets)
          .where(eq(assets.id, result.assetId))
          .limit(1);
        const accountId = owners.at(0)?.accountId;
        if (
          result.status === 'ready' &&
          accountId &&
          (accountId !== parsedAccountId ||
            result.normalizedKey !==
              assetKeysFor(accountId, result.assetId).normalized)
        ) {
          throw new Error('Normalized key does not belong to asset owner');
        }
        const updated = await this.database
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
          )
          .returning({ id: assets.id });
        if (updated.length === 0) {
          const existing = await this.database
            .select({ id: assets.id })
            .from(assets)
            .where(eq(assets.id, result.assetId))
            .limit(1);
          if (existing.length === 0 && result.status === 'ready') {
            await this.objects.deleteKey('normalized', result.normalizedKey);
          }
        }
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
