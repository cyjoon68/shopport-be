import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { describe, expect, it, jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';

import type { Environment } from '../config/environment.js';
import type { Database } from '../database/database.module.js';
import type { ObjectStore } from '../storage/object-store.js';
import { AssetResultConsumer } from './asset-result.consumer.js';

const accountId = '0198a122-0c00-7000-8000-000000000001';
const otherAccountId = '0198a122-0c00-7000-8000-000000000004';
const assetId = '0198a122-0c00-7000-8000-000000000002';
const normalizedKey = `uploads/${accountId}/${assetId}/normalized.jpg`;

const config = new ConfigService<Environment, true>({
  AWS_REGION: 'ap-northeast-2',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  SQS_ASSET_RESULT_URL: 'http://localhost:4566/queue/results',
} as Environment);

const messageFor = (
  result: unknown,
  receiptHandle = 'receipt',
): Readonly<{ Body: string; ReceiptHandle: string }> => ({
  Body: JSON.stringify(result),
  ReceiptHandle: receiptHandle,
});

const readyResult = {
  assetId,
  normalizedKey,
  status: 'ready',
  width: 100,
  height: 200,
};

const databaseFor = (
  selectResults: ReadonlyArray<ReadonlyArray<Record<string, string>>>,
  updated: ReadonlyArray<Readonly<{ id: string }>>,
): Database => {
  const remainingSelections = [...selectResults];
  const limit = jest.fn(() =>
    Promise.resolve(remainingSelections.shift() ?? []),
  );
  const whereSelect = jest.fn(() => ({ limit }));
  const from = jest.fn(() => ({ where: whereSelect }));
  const returning = jest.fn(() => Promise.resolve(updated));
  const whereUpdate = jest.fn(() => ({ returning }));
  const set = jest.fn(() => ({ where: whereUpdate }));
  return {
    select: jest.fn(() => ({ from })),
    update: jest.fn(() => ({ set })),
  } as unknown as Database;
};

const objectStoreFor = (
  deleteKey: (bucket: string, key: string) => Promise<void>,
): ObjectStore => ({ deleteKey }) as unknown as ObjectStore;

describe('AssetResultConsumer failure isolation', () => {
  it('deletes an orphaned normalized object before acknowledging the result', async () => {
    const order: string[] = [];
    let resolveDeleteStarted = (): void => undefined;
    let resolveDelete = (): void => undefined;
    const deleteStarted = new Promise<void>((resolve) => {
      resolveDeleteStarted = resolve;
    });
    const deletion = new Promise<void>((resolve) => {
      resolveDelete = resolve;
    });
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation((command: unknown) => {
        if (command instanceof ReceiveMessageCommand) {
          return Promise.resolve({
            Messages: [messageFor(readyResult)],
          }) as never;
        }
        if (command instanceof DeleteMessageCommand) order.push('acknowledge');
        return Promise.resolve({}) as never;
      });
    const deleteKey = jest
      .fn<(bucket: string, key: string) => Promise<void>>()
      .mockImplementation(() => {
        order.push('delete');
        resolveDeleteStarted();
        return deletion;
      });
    const consumer = new AssetResultConsumer(
      databaseFor([[{ accountId }], []], []),
      config,
      objectStoreFor(deleteKey),
    );

    const consumption = consumer.consume();
    await deleteStarted;

    expect(order).toEqual(['delete']);
    expect(send).toHaveBeenCalledTimes(1);

    resolveDelete();
    await expect(consumption).resolves.toBe(true);

    expect(deleteKey).toHaveBeenCalledWith('normalized', normalizedKey);
    expect(order).toEqual(['delete', 'acknowledge']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('acknowledges a duplicate result for a terminal asset without deleting its object', async () => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(
        (command: unknown) =>
          Promise.resolve(
            command instanceof ReceiveMessageCommand
              ? { Messages: [messageFor(readyResult)] }
              : {},
          ) as never,
      );
    const deleteKey = jest.fn(() => Promise.resolve());
    const consumer = new AssetResultConsumer(
      databaseFor([[{ accountId }], [{ id: assetId }]], []),
      config,
      objectStoreFor(deleteKey),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(deleteKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...readyResult, normalizedKey: null },
    {
      assetId,
      normalizedKey,
      status: 'rejected',
      width: null,
      height: null,
    },
    {
      assetId,
      normalizedKey: null,
      status: 'rejected',
      width: 100,
      height: null,
    },
  ])('leaves an invalid result unacknowledged', async (result) => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(
        (command: unknown) =>
          Promise.resolve(
            command instanceof ReceiveMessageCommand
              ? { Messages: [messageFor(result)] }
              : {},
          ) as never,
      );
    const database = databaseFor([], []);
    const update = jest.spyOn(database, 'update');
    const deleteKey = jest.fn(() => Promise.resolve());
    const consumer = new AssetResultConsumer(
      database,
      config,
      objectStoreFor(deleteKey),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(update).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not delete or acknowledge a key for a different asset', async () => {
    const send = jest.spyOn(SQSClient.prototype, 'send').mockImplementation(
      (command: unknown) =>
        Promise.resolve(
          command instanceof ReceiveMessageCommand
            ? {
                Messages: [
                  messageFor({
                    ...readyResult,
                    normalizedKey: `uploads/${accountId}/0198a122-0c00-7000-8000-000000000003/normalized.jpg`,
                  }),
                ],
              }
            : {},
        ) as never,
    );
    const database = databaseFor([], []);
    const update = jest.spyOn(database, 'update');
    const deleteKey = jest.fn(() => Promise.resolve());
    const consumer = new AssetResultConsumer(
      database,
      config,
      objectStoreFor(deleteKey),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(update).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not update, delete, or acknowledge a valid key owned by a different account', async () => {
    const send = jest.spyOn(SQSClient.prototype, 'send').mockImplementation(
      (command: unknown) =>
        Promise.resolve(
          command instanceof ReceiveMessageCommand
            ? {
                Messages: [
                  messageFor({
                    ...readyResult,
                    normalizedKey: `uploads/${otherAccountId}/${assetId}/normalized.jpg`,
                  }),
                ],
              }
            : {},
        ) as never,
    );
    const database = databaseFor([[{ accountId }]], []);
    const update = jest.spyOn(database, 'update');
    const deleteKey = jest.fn(() => Promise.resolve());
    const consumer = new AssetResultConsumer(
      database,
      config,
      objectStoreFor(deleteKey),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(update).not.toHaveBeenCalled();
    expect(deleteKey).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves an orphaned result unacknowledged when object deletion fails', async () => {
    const send = jest
      .spyOn(SQSClient.prototype, 'send')
      .mockImplementation(
        (command: unknown) =>
          Promise.resolve(
            command instanceof ReceiveMessageCommand
              ? { Messages: [messageFor(readyResult)] }
              : {},
          ) as never,
      );
    const deleteKey = jest
      .fn<(bucket: string, key: string) => Promise<void>>()
      .mockRejectedValue(new Error('S3 unavailable'));
    const consumer = new AssetResultConsumer(
      databaseFor([[{ accountId }], []], []),
      config,
      objectStoreFor(deleteKey),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(deleteKey).toHaveBeenCalledWith('normalized', normalizedKey);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('leaves malformed JSON for redrive and processes the next message', async () => {
    const send = jest.spyOn(SQSClient.prototype, 'send').mockImplementation(
      (command: unknown) =>
        Promise.resolve(
          command instanceof ReceiveMessageCommand
            ? {
                Messages: [
                  { Body: '{', ReceiptHandle: 'invalid' },
                  messageFor(
                    {
                      assetId,
                      normalizedKey: null,
                      status: 'rejected',
                      width: null,
                      height: null,
                    },
                    'valid',
                  ),
                ],
              }
            : {},
        ) as never,
    );
    const consumer = new AssetResultConsumer(
      databaseFor([[{ accountId }]], [{ id: assetId }]),
      config,
      objectStoreFor(() => Promise.resolve()),
    );

    await expect(consumer.consume()).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(2);
  });
});
