import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AiController } from './ai.controller.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AI_STREAM_ADAPTER } from './ai-stream.adapter.js';
import { AiTools } from './ai-tools.js';
import {
  AI_PROVIDER_FETCH,
  OpenAiCompatibleAiStreamAdapter,
} from './openai-compatible-ai.adapter.js';

export const aiStreamAdapterProvider = {
  provide: AI_STREAM_ADAPTER,
  useExisting: OpenAiCompatibleAiStreamAdapter,
};

@Module({
  imports: [AssetsModule, CatalogModule],
  controllers: [AiController],
  providers: [
    AiRepository,
    AiService,
    AiTools,
    OpenAiCompatibleAiStreamAdapter,
    { provide: AI_PROVIDER_FETCH, useValue: globalThis.fetch },
    aiStreamAdapterProvider,
  ],
})
export class AiModule {}
