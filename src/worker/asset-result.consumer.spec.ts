import { ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment.js';
import type { Database } from '../database/database.module.js';
import { AssetResultConsumer } from './asset-result.consumer.js';

describe('AssetResultConsumer failure isolation', () => {
  it('leaves a malformed result for redrive and processes the next message', async () => {
    const send = jest.spyOn(SQSClient.prototype, 'send').mockImplementation(
      (command: unknown) =>
        Promise.resolve(
          command instanceof ReceiveMessageCommand
            ? {
                Messages: [
                  { Body: '{', ReceiptHandle: 'invalid' },
                  {
                    Body: JSON.stringify({
                      assetId: '0198a122-0c00-7000-8000-000000000001',
                      normalizedKey: 'uploads/account/asset/normalized.jpg',
                      status: 'ready',
                      width: 100,
                      height: 100,
                    }),
                    ReceiptHandle: 'valid',
                  },
                ],
              }
            : {},
        ) as never,
    );
    const where = jest.fn(() => Promise.resolve());
    const set = jest.fn(() => ({ where }));
    const database = {
      update: jest.fn(() => ({ set })),
    } as unknown as Database;
    const config = new ConfigService<Environment, true>({
      AWS_REGION: 'ap-northeast-2',
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      SQS_ASSET_RESULT_URL: 'http://localhost:4566/queue/results',
    } as Environment);
    const consumer = new AssetResultConsumer(database, config);

    await expect(consumer.consume()).resolves.toBe(true);

    expect(set).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
