import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from '../config/environment.js';
import { DatabaseModule } from '../database/database.module.js';
import { RedisModule } from '../redis/redis.module.js';
import { ArchiveModule } from '../modules/archive/archive.module.js';
import { AssetResultConsumer } from './asset-result.consumer.js';
import { OutboxProcessor } from './outbox.processor.js';

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
  ],
  providers: [AssetResultConsumer, OutboxProcessor],
})
export class WorkerModule {}
