import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { ArchiveWriter } from './modules/archive/archive.writer.js';
import { AssetResultConsumer } from './worker/asset-result.consumer.js';
import { OutboxProcessor } from './worker/outbox.processor.js';
import { StaleRunRecovery } from './worker/stale-run-recovery.js';
import { WorkerModule } from './worker/worker.module.js';

const recoveryCadenceMilliseconds = 30_000;

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const complete = (): void => {
      signal.removeEventListener('abort', complete);
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    signal.addEventListener('abort', complete, { once: true });
  });

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const assets = app.get(AssetResultConsumer);
  const outbox = app.get(OutboxProcessor);
  const archives = app.get(ArchiveWriter);
  const staleRuns = app.get(StaleRunRecovery);
  const controller = new AbortController();
  let nextRecoveryAt = 0;
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!controller.signal.aborted) {
    const recoveryDue = Date.now() >= nextRecoveryAt;
    if (recoveryDue) nextRecoveryAt = Date.now() + recoveryCadenceMilliseconds;
    const results = await Promise.allSettled([
      assets.consume(),
      outbox.process(),
      archives.archive(),
      recoveryDue ? staleRuns.recover() : Promise.resolve(0),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') {
        process.stderr.write(
          `${result.reason instanceof Error ? result.reason.message : 'Worker task failed'}\n`,
        );
      }
    }
    const assetWork = results[0].status === 'fulfilled' && results[0].value;
    const outboxWork = results[1].status === 'fulfilled' && results[1].value;
    const archiveWork = results[2].status === 'fulfilled' && results[2].value;
    const recoveredRuns =
      results[3].status === 'fulfilled' ? results[3].value : 0;
    if (!assetWork && !outboxWork && !archiveWork && recoveredRuns === 0) {
      await delay(500, controller.signal);
    }
  }
  await app.close();
};

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Worker failed'}\n`,
  );
  process.exitCode = 1;
});
