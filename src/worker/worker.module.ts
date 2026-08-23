import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '../config/environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { ArchiveModule } from '../modules/archive/archive.module.js';
import { AiRepository } from '../modules/ai/ai.repository.js';
import { CatalogModule } from '../modules/catalog/catalog.module.js';
import { AssetResultConsumer } from './asset-result.consumer.js';
import { OutboxProcessor } from './outbox.processor.js';
import { StaleRunRecovery } from './stale-run-recovery.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    RedisModule,
    ArchiveModule,
    CatalogModule,
  ],
  providers: [
    AiRepository,
    AssetResultConsumer,
    OutboxProcessor,
    StaleRunRecovery,
  ],
})
export class WorkerModule {}
