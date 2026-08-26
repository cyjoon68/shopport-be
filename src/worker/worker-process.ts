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

const report = (task: string, reason: unknown): void => {
  const error = reason instanceof Error ? reason : null;
  const record = error?.stack
    ? { task, message: error.message, stack: error.stack }
    : { task, message: error?.message ?? 'Worker failure' };
  process.stderr.write(`${JSON.stringify(record)}\n`);
};

export { delay, report };
