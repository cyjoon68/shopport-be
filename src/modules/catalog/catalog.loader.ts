import { Injectable, Scope } from '@nestjs/common';
import DataLoader from 'dataloader';
import { CatalogService } from './catalog.service.js';
import type { CatalogProduct } from './types.js';

@Injectable({ scope: Scope.REQUEST })
export class CatalogLoader {
  readonly #loader: DataLoader<string, CatalogProduct>;

  public constructor(catalog: CatalogService) {
    this.#loader = new DataLoader<string, CatalogProduct>(async (ids) => {
      const products = await catalog.getProducts(ids);
      return products.map((product, index) => {
        if (product) return product;
        return new Error(`Product ${ids.at(index) ?? 'unknown'} not found`);
      });
    });
  }

  public load = (id: string): Promise<CatalogProduct> => this.#loader.load(id);
}
