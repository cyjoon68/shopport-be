type RunStatus = 'reserved' | 'completed' | 'failed' | 'cancelled';

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

  public cancel = (runId: string): void => {
    if (this.#runs.get(runId) === 'reserved') {
      this.#runs.set(runId, 'cancelled');
    }
  };

  public status = (runId: string): RunStatus | null =>
    this.#runs.get(runId) ?? null;
}
