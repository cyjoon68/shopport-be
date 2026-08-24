import { Injectable } from '@nestjs/common';

import { AiRepository } from '../modules/ai/ai.repository.js';

@Injectable()
export class StaleRunRecovery {
  public constructor(private readonly repository: AiRepository) {}

  public recover = async (): Promise<number> => {
    const [recovered] = await Promise.all([
      this.repository.recoverStaleReservedRuns(),
      this.repository.cleanupRuntimeState(),
    ]);
    return recovered;
  };
}
