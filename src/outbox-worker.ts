import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { OutboxProcessor } from './worker/outbox.processor.js';
import { runOutboxWorker } from './worker/outbox-runner.js';
import { OutboxWakeup } from './worker/outbox-wakeup.js';
import { WorkerModule } from './worker/worker.module.js';
import { report } from './worker/worker-process.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const outbox = app.get(OutboxProcessor);
  const wakeup = app.get(OutboxWakeup);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await runOutboxWorker(outbox, wakeup, controller.signal);
  } finally {
    controller.abort();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await app.close();
  }
};

bootstrap().catch((error: unknown) => {
  report('outbox-worker', error);
  process.exitCode = 1;
});
