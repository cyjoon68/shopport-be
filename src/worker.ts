import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { ArchiveWriter } from './modules/archive/archive.writer.js';
import { AssetResultConsumer } from './worker/asset-result.consumer.js';
import { RetentionCleanup } from './worker/retention-cleanup.js';
import { StaleRunRecovery } from './worker/stale-run-recovery.js';
import { WorkerModule } from './worker/worker.module.js';
import { delay, report } from './worker/worker-process.js';

const recoveryCadenceMilliseconds = 30_000;
const retentionCadenceMilliseconds = 300_000;

const runMaintenance = async (
  assets: AssetResultConsumer,
  archives: ArchiveWriter,
  staleRuns: StaleRunRecovery,
  retention: RetentionCleanup,
  signal: AbortSignal,
): Promise<void> => {
  let nextRecoveryAt = 0;
  let nextRetentionAt = 0;
  while (!signal.aborted) {
    const recoveryDue = Date.now() >= nextRecoveryAt;
    const retentionDue = Date.now() >= nextRetentionAt;
    if (recoveryDue) nextRecoveryAt = Date.now() + recoveryCadenceMilliseconds;
    if (retentionDue)
      nextRetentionAt = Date.now() + retentionCadenceMilliseconds;
    const [assetResults, archiveResult, staleRunResult, retentionResult] =
      await Promise.allSettled([
        assets.consume(),
        archives.archive(),
        recoveryDue ? staleRuns.recover() : Promise.resolve(0),
        retentionDue ? retention.cleanup() : Promise.resolve(),
      ]);
    for (const [task, result] of [
      ['asset-results', assetResults],
      ['archive', archiveResult],
      ['stale-runs', staleRunResult],
      ['retention', retentionResult],
    ] as const) {
      if (result.status === 'rejected') {
        report(task, result.reason);
      }
    }
    const assetWork = assetResults.status === 'fulfilled' && assetResults.value;
    const archiveWork =
      archiveResult.status === 'fulfilled' && archiveResult.value;
    const recoveredRuns =
      staleRunResult.status === 'fulfilled' ? staleRunResult.value : 0;
    if (!assetWork && !archiveWork && recoveredRuns === 0) {
      await delay(500, signal);
    }
  }
};

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const assets = app.get(AssetResultConsumer);
  const archives = app.get(ArchiveWriter);
  const retention = app.get(RetentionCleanup);
  const staleRuns = app.get(StaleRunRecovery);
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await runMaintenance(
      assets,
      archives,
      staleRuns,
      retention,
      controller.signal,
    );
  } finally {
    controller.abort();
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await app.close();
  }
};

bootstrap().catch((error: unknown) => {
  report('worker', error);
  process.exitCode = 1;
});
