import { describe, expect, it, jest } from '@jest/globals';
import { MODULE_METADATA } from '@nestjs/common/constants.js';

import { AiRepository } from '../modules/ai/ai.repository.js';
import { AiRunMaintenanceRepository } from '../modules/ai/ai-run-maintenance.repository.js';
import { CatalogModule } from '../modules/catalog/catalog.module.js';
import { StaleRunRecovery } from './stale-run-recovery.js';
import { WorkerModule } from './worker.module.js';

describe('StaleRunRecovery', () => {
  it('runs recovery and runtime cleanup together', async () => {
    const repository = {
      recoverStaleReservedRuns: jest.fn(() => Promise.resolve(2)),
      cleanupRuntimeState: jest.fn(() => Promise.resolve()),
    } as unknown as AiRunMaintenanceRepository;
    const recovery = new StaleRunRecovery(repository);

    await expect(recovery.recover()).resolves.toBe(2);

    expect(repository.cleanupRuntimeState).toHaveBeenCalledTimes(1);
  });

  it('does not include request catalog dependencies in the worker module', () => {
    const imports =
      (Reflect.getMetadata(
        MODULE_METADATA.IMPORTS,
        WorkerModule,
      ) as unknown as ReadonlyArray<unknown> | undefined) ?? [];
    const providers =
      (Reflect.getMetadata(
        MODULE_METADATA.PROVIDERS,
        WorkerModule,
      ) as unknown as ReadonlyArray<unknown> | undefined) ?? [];

    expect(imports).not.toContain(CatalogModule);
    expect(providers).toContain(AiRunMaintenanceRepository);
    expect(providers).not.toContain(AiRepository);
  });
});
