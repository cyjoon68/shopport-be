import { toProductGraphql } from './catalog.mapper.js';
import type { CatalogProduct } from './types.js';

const product: CatalogProduct = {
  affiliate: false,
  availability: 'UNKNOWN',
  deliveryEstimateDays: null,
  evidence: [],
  freshnessEpochMs: 1,
  id: '0198a122-0c00-7000-8000-000000000001',
  imageUrl: 'https://images.example.com/product.jpg',
  inStock: false,
  inventory: null,
  outboundUrl: 'https://www.daisomall.co.kr/ds/prd/detail?pdNo=product-1',
  productCode: 'product-1',
  providerId: 'daiso',
  ratingConfidence: 1,
  relevanceBucket: 1,
  store: null,
  title: '상품',
  totalAmountMinor: '1000',
};

describe('toProductGraphql', () => {
  it('keeps unknown stock distinct from the legacy boolean', () => {
    expect(toProductGraphql(product).offer).toMatchObject({
      availability: 'UNKNOWN',
      isInStock: false,
    });
  });
});
