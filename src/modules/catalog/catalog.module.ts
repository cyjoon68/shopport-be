import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../../config/environment.js';
import { CatalogLoader } from './catalog.loader.js';
import { CatalogResolver } from './catalog.resolver.js';
import { CatalogService } from './catalog.service.js';
import { CATALOG_PROVIDER } from './catalog.tokens.js';
import { FakeCatalogProvider } from './fake-catalog.provider.js';

@Module({
  providers: [
    FakeCatalogProvider,
    {
      provide: CATALOG_PROVIDER,
      inject: [ConfigService, FakeCatalogProvider],
      useFactory: (
        config: ConfigService<Environment, true>,
        fake: FakeCatalogProvider,
      ): FakeCatalogProvider => {
        if (config.get('CATALOG_MODE', { infer: true }) === 'fake') return fake;
        throw new Error('Approved catalog provider adapter is not configured');
      },
    },
    CatalogService,
    CatalogLoader,
    CatalogResolver,
  ],
  exports: [CatalogService],
})
export class CatalogModule {}
