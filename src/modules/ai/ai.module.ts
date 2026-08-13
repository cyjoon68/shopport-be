import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog/catalog.module.js';
import { AiController } from './ai.controller.js';
import { AiRepository } from './ai.repository.js';
import { AiService } from './ai.service.js';
import { AiTools } from './ai-tools.js';
import { RedisRunCancellation } from './redis-run-cancellation.js';

@Module({
  imports: [CatalogModule],
  controllers: [AiController],
  providers: [AiRepository, AiService, AiTools, RedisRunCancellation],
})
export class AiModule {}
