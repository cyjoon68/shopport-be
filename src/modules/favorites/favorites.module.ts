import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module.js';
import { FavoritesRepository } from './favorites.repository.js';
import { FavoritesResolver } from './favorites.resolver.js';

@Module({
  imports: [CatalogModule],
  providers: [FavoritesRepository, FavoritesResolver],
})
export class FavoritesModule {}
