import { Module } from '@nestjs/common';

import { ArchiveModule } from '../archive/archive.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { ConversationRepository } from './conversation.repository.js';
import { ConversationResolver } from './conversation.resolver.js';
import { ConversationService } from './conversation.service.js';
import { MessageLoader } from './message.loader.js';

@Module({
  imports: [CatalogModule, ArchiveModule],
  providers: [
    ConversationRepository,
    ConversationService,
    ConversationResolver,
    MessageLoader,
  ],
})
export class ConversationModule {}
