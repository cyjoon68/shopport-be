import { Module } from '@nestjs/common';

import { AssetsRepository } from './assets.repository.js';
import { AssetsResolver } from './assets.resolver.js';
import { AssetsService } from './assets.service.js';

@Module({
  providers: [AssetsRepository, AssetsService, AssetsResolver],
  exports: [AssetsService],
})
export class AssetsModule {}
