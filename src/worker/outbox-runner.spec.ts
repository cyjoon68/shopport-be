import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { OutboxProcessor } from './outbox.processor.js';
import { runOutboxWorker } from './outbox-runner.js';
import type { OutboxWakeup } from './outbox-wakeup.js';

describe('runOutboxWorker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('continues processing with capped polling and retries a failed listener', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const listen = jest
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('listener unavailable'))
      .mockResolvedValueOnce(undefined);
    const outboxProcess = jest
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    const nextWakeDelay = jest
      .fn<(fallbackMilliseconds: number) => Promise<number>>()
      .mockResolvedValue(30_000);
    const wait = jest.fn((milliseconds: number, signal: AbortSignal) => {
      void milliseconds;
      void signal;
      controller.abort();
      return Promise.resolve(false);
    });
    const write = jest
      .spyOn(globalThis.process.stderr, 'write')
      .mockImplementation(() => true);

    const running = runOutboxWorker(
      { nextWakeDelay, process: outboxProcess } as unknown as OutboxProcessor,
      { listen, wait } as unknown as OutboxWakeup,
      controller.signal,
    );

    await jest.advanceTimersByTimeAsync(4_999);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(outboxProcess).toHaveBeenCalledTimes(1);
    expect(nextWakeDelay).toHaveBeenCalledWith(30_000);

    await jest.advanceTimersByTimeAsync(1);
    await running;

    expect(listen).toHaveBeenCalledTimes(2);
    expect(outboxProcess).toHaveBeenCalledTimes(2);
    expect(nextWakeDelay).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(30_000, controller.signal);
    expect(write).toHaveBeenCalled();
  });
});
