import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { OutboxProcessor } from './worker/outbox.processor.js';
import { OutboxWakeup } from './worker/outbox-wakeup.js';
import { WorkerModule } from './worker/worker.module.js';
import { delay, report } from './worker/worker-process.js';

const fallbackCadenceMilliseconds = 30_000;
const degradedCadenceMilliseconds = 5_000;

const run = async (
  outbox: OutboxProcessor,
  wakeup: OutboxWakeup,
  signal: AbortSignal,
): Promise<void> => {
  let listenerUnavailable = false;
  let processorUnavailable = false;
  while (!signal.aborted) {
    let listening = true;
    try {
      await wakeup.listen();
      listenerUnavailable = false;
    } catch (error) {
      listening = false;
      if (!listenerUnavailable) report('Outbox listener failed', error);
      listenerUnavailable = true;
    }
    try {
      const processed = await outbox.process();
      processorUnavailable = false;
      if (processed) continue;
      const waitMilliseconds = await outbox.nextWakeDelay(
        fallbackCadenceMilliseconds,
      );
      if (listening) {
        try {
          await wakeup.wait(waitMilliseconds, signal);
          continue;
        } catch (error) {
          if (!listenerUnavailable) report('Outbox listener failed', error);
          listenerUnavailable = true;
        }
      }
      await delay(
        Math.min(waitMilliseconds, degradedCadenceMilliseconds),
        signal,
      );
    } catch (error) {
      if (!processorUnavailable) report('Outbox processor failed', error);
      processorUnavailable = true;
      await delay(degradedCadenceMilliseconds, signal);
    }
  }
};

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
    await run(outbox, wakeup, controller.signal);
  } finally {
    controller.abort();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await app.close();
  }
};

bootstrap().catch((error: unknown) => {
  report('Outbox worker failed', error);
  process.exitCode = 1;
});
