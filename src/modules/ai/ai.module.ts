import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AiController } from './ai.controller.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiTools } from './ai-tools.js';
import { RedisRunCancellation } from './redis-run-cancellation.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import type { AiStreamAdapter } from './ai-stream.adapter.js';
import {
  COMMAND_CODE_FETCH,
  CommandCodeAiStreamAdapter,
} from './command-code-ai.adapter.js';
import { FakeAiStreamAdapter } from './fake-ai.adapter.js';

export const aiStreamAdapterProvider = {
  provide: AI_STREAM_ADAPTER,
  inject: [ConfigService, FakeAiStreamAdapter, CommandCodeAiStreamAdapter],
  useFactory: (
    config: ConfigService<Environment, true>,
    fake: FakeAiStreamAdapter,
    commandCode: CommandCodeAiStreamAdapter,
  ): AiStreamAdapter => {
    if (config.get('AI_MODE', { infer: true }) === 'fake') return fake;
    return commandCode;
  },
};

@Module({
  imports: [AssetsModule, CatalogModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    AiTools,
    RedisRunCancellation,
    FakeAiStreamAdapter,
    CommandCodeAiStreamAdapter,
    { provide: COMMAND_CODE_FETCH, useValue: globalThis.fetch },
    aiStreamAdapterProvider,
  ],
})
export class AiModule {}
