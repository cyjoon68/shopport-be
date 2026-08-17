import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AiController } from './ai.controller.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiTools } from './ai-tools.js';
import { RedisRunCancellation } from './redis-run-cancellation.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import {
  COMMAND_CODE_FETCH,
  CommandCodeAiStreamAdapter,
} from './command-code-ai.adapter.js';

export const aiStreamAdapterProvider = {
  provide: AI_STREAM_ADAPTER,
  useExisting: CommandCodeAiStreamAdapter,
};

@Module({
  imports: [AssetsModule, CatalogModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    AiTools,
    RedisRunCancellation,
    CommandCodeAiStreamAdapter,
    { provide: COMMAND_CODE_FETCH, useValue: globalThis.fetch },
    aiStreamAdapterProvider,
  ],
})
export class AiModule {}
