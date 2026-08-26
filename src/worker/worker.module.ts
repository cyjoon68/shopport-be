import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnvironment } from '../config/environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { AiRepository } from '../modules/ai/ai.repository.js';
import { ArchiveModule } from '../modules/archive/archive.module.js';
import { CatalogModule } from '../modules/catalog/catalog.module.js';
import { AssetResultConsumer } from './asset-result.consumer.js';
import { OutboxProcessor } from './outbox.processor.js';
import { OutboxWakeup } from './outbox-wakeup.js';
import { RetentionCleanup } from './retention-cleanup.js';
import { StaleRunRecovery } from './stale-run-recovery.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ArchiveModule,
    CatalogModule,
  ],
  providers: [
    AiRepository,
    AssetResultConsumer,
    OutboxProcessor,
    OutboxWakeup,
    RetentionCleanup,
    StaleRunRecovery,
  ],
})
export class WorkerModule {}
