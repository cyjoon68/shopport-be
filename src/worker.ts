import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AssetResultConsumer } from './worker/asset-result.consumer.js';
import { OutboxProcessor } from './worker/outbox.processor.js';
import { WorkerModule } from './worker/worker.module.js';
import { ArchiveWriter } from './modules/archive/archive.writer.js';

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const assets = app.get(AssetResultConsumer);
  const outbox = app.get(OutboxProcessor);
  const archives = app.get(ArchiveWriter);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!controller.signal.aborted) {
    const [assetWork, outboxWork, archiveWork] = await Promise.all([
      assets.consume(),
      outbox.process(),
      archives.archive(),
    ]);
    if (!assetWork && !outboxWork && !archiveWork) await delay(500);
  }
  await app.close();
};

bootstrap().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Worker failed'}\n`,
  );
  process.exitCode = 1;
});
