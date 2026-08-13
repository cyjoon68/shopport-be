import { Injectable } from '@nestjs/common';
import { AiRepository } from '../modules/ai/ai.repository.js';

@Injectable()
export class StaleRunRecovery {
  public constructor(private readonly repository: AiRepository) {}

  public recover = (): Promise<number> =>
    this.repository.recoverStaleReservedRuns();
}
