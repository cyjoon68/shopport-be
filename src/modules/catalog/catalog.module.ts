import { Module } from '@nestjs/common';
import { CatalogLoader } from './catalog.loader.js';
import { CatalogResolver } from './catalog.resolver.js';
import { CatalogService } from './catalog.service.js';
import { CATALOG_PROVIDER } from './catalog.tokens.js';
import { CatalogProvider } from './catalog.provider.js';

@Module({
  providers: [
    CatalogProvider,
    {
      provide: CATALOG_PROVIDER,
      useExisting: CatalogProvider,
    },
    CatalogService,
    CatalogLoader,
    CatalogResolver,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
