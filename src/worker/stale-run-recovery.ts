import { Injectable } from '@nestjs/common';

import { AiRunMaintenanceRepository } from '../modules/ai/ai-run-maintenance.repository.js';

@Injectable()
export class StaleRunRecovery {
  public constructor(private readonly repository: AiRunMaintenanceRepository) {}

  public recover = async (): Promise<number> => {
    const recovered = await this.repository.recoverStaleReservedRuns();
    await this.repository.cleanupRuntimeState();
    return recovered;
  };
}
