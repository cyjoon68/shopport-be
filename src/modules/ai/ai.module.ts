import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AiController } from './ai.controller.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiTools } from './ai-tools.js';
import { RedisRunCancellation } from './redis-run-cancellation.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import { FakeAiStreamAdapter } from './fake-ai.adapter.js';

export const aiStreamAdapterProvider = {
  provide: AI_STREAM_ADAPTER,
  inject: [ConfigService, FakeAiStreamAdapter],
  useFactory: (
    config: ConfigService<Environment, true>,
    fake: FakeAiStreamAdapter,
  ): FakeAiStreamAdapter => {
    if (config.get('AI_MODE', { infer: true }) === 'fake') return fake;
    throw new Error('Approved AI provider adapter is not configured');
  },
};

@Module({
  imports: [CatalogModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    AiTools,
    RedisRunCancellation,
    FakeAiStreamAdapter,
    aiStreamAdapterProvider,
  ],
})
export class AiModule {}
