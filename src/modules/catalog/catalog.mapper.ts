import type { CatalogProduct } from './types.js';

export type ProductGraphql = Readonly<{
  id: string;
  provider: Readonly<{ providerId: string; displayName: string }>;
  title: string;
  imageUrl: string;
  isAffiliate: boolean;
  isSaved: boolean;
  offer: Readonly<{
    id: string;
    price: Readonly<{ amountMinor: string; currency: string }>;
    shipping: Readonly<{ amountMinor: string; currency: string }>;
    total: Readonly<{ amountMinor: string; currency: string }>;
    isInStock: boolean;
    availability: CatalogProduct['availability'];
    deliveryExpectedAt: Date | null;
    observedAt: Date;
    outboundUrl: string;
  }>;
}>;

const providerNames: Readonly<Record<string, string>> = {
  oliveyoung: '올리브영',
  coupang: '쿠팡',
  daiso: '다이소',
  naver: '네이버 쇼핑',
  gmarket: 'G마켓',
};

export const toProductGraphql = (
  product: CatalogProduct,
  isSaved = false,
): ProductGraphql => ({
  id: product.id,
  provider: {
    providerId: product.providerId,
    displayName: providerNames[product.providerId] ?? product.providerId,
  },
  title: product.title,
  imageUrl: product.imageUrl,
  isAffiliate: product.affiliate,
  isSaved,
  offer: {
    id: product.id,
    price: { amountMinor: product.totalAmountMinor, currency: 'KRW' },
    shipping: { amountMinor: '0', currency: 'KRW' },
    total: { amountMinor: product.totalAmountMinor, currency: 'KRW' },
    isInStock: product.inStock,
    availability: product.availability,
    deliveryExpectedAt:
      product.deliveryEstimateDays === null
        ? null
        : new Date(Date.now() + product.deliveryEstimateDays * 86_400_000),
    observedAt: new Date(product.freshnessEpochMs),
    outboundUrl: product.outboundUrl,
  },
});

export const productCursor = (id: string): string =>
  Buffer.from(`product:${id}`, 'utf8').toString('base64url');
