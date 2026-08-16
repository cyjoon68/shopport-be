import { Module } from '@nestjs/common';
import { CatalogLoader } from './catalog.loader.js';
import { CatalogResolver } from './catalog.resolver.js';
import { CatalogService } from './catalog.service.js';
import { CATALOG_PROVIDER } from './catalog.tokens.js';
import { RetailCatalogProvider } from './retail-catalog.provider.js';

@Module({
  providers: [
    RetailCatalogProvider,
    {
      provide: CATALOG_PROVIDER,
      inject: [RetailCatalogProvider],
      useFactory: (retail: RetailCatalogProvider): RetailCatalogProvider =>
        retail,
    },
    CatalogService,
    CatalogLoader,
    CatalogResolver,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
