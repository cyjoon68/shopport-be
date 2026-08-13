export class AiAccessError extends Error {
  public constructor(public readonly code: 'TRIAL_EXPIRED' | 'QUOTA_EXCEEDED') {
    super(code);
    this.name = 'AiAccessError';
  }
}
