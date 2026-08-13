type RunStatus = 'reserved' | 'completed' | 'failed';

export class RunLedger {
  readonly #runs = new Map<string, RunStatus>();

  public begin = (runId: string): boolean => {
    if (this.#runs.has(runId)) return false;
    this.#runs.set(runId, 'reserved');
    return true;
  };

  public complete = (runId: string): void => {
    if (this.#runs.get(runId) === 'reserved')
      this.#runs.set(runId, 'completed');
  };

  public fail = (runId: string): void => {
    if (this.#runs.get(runId) === 'reserved') this.#runs.set(runId, 'failed');
  };

  public status = (runId: string): RunStatus | null =>
    this.#runs.get(runId) ?? null;
}
