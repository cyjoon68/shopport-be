import type { OutboxProcessor } from './outbox.processor.js';
import type { OutboxWakeup } from './outbox-wakeup.js';
import { delay, report } from './worker-process.js';

const fallbackCadenceMilliseconds = 30_000;
const degradedCadenceMilliseconds = 5_000;

const runOutboxWorker = async (
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
      if (!listenerUnavailable) report('outbox-listener', error);
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
          if (!listenerUnavailable) report('outbox-listener', error);
          listenerUnavailable = true;
        }
      }
      await delay(
        Math.min(waitMilliseconds, degradedCadenceMilliseconds),
        signal,
      );
    } catch (error) {
      if (!processorUnavailable) report('outbox-processor', error);
      processorUnavailable = true;
      await delay(degradedCadenceMilliseconds, signal);
    }
  }
};

export { runOutboxWorker };
