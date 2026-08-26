import { Module } from '@nestjs/common';

import { CatalogProvider } from './catalog.provider.js';
import { CatalogRepository } from './catalog.repository.js';
import { CatalogResolver } from './catalog.resolver.js';
import { CatalogService } from './catalog.service.js';
import { CATALOG_PROVIDER } from './catalog.tokens.js';

@Module({
  providers: [
    CatalogProvider,
    {
      provide: CATALOG_PROVIDER,
      useExisting: CatalogProvider,
    },
    CatalogRepository,
    CatalogService,
    CatalogResolver,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
