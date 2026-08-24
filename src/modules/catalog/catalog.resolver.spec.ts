import { jest } from '@jest/globals';

import { CatalogResolver } from './catalog.resolver.js';
import type { CatalogService } from './catalog.service.js';

const productId = '0198a122-0c00-7000-8000-000000000001';

describe('catalog resolver', () => {
  it('keeps the legacy product query compatible', async () => {
    const getProduct = jest.fn<
      (id: string) => ReturnType<CatalogService['getProduct']>
    >(() => Promise.resolve(null));
    const resolver = new CatalogResolver({
      getProduct,
    } as unknown as CatalogService);

    await expect(resolver.product(productId)).resolves.toBeNull();
    expect(getProduct).toHaveBeenCalledWith(productId);
  });
});
