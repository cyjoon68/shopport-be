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

const report = (fallback: string, reason: unknown): void => {
  process.stderr.write(
    `${reason instanceof Error ? reason.message : fallback}\n`,
  );
};

export { delay, report };
