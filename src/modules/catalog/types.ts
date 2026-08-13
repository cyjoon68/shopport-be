export type CatalogCapability = 'LIVE_QUERY' | 'LICENSED_FEED';

export type CatalogProduct = Readonly<{
  id: string;
  providerId: string;
  title: string;
  imageUrl: string;
  affiliate: boolean;
  relevanceBucket: number;
  inStock: boolean;
  totalAmountMinor: string;
  deliveryEstimateDays: number | null;
  ratingConfidence: number;
  freshnessEpochMs: number;
  outboundUrl: string;
}>;

export type CatalogSearchInput = Readonly<{
  query: string;
  first: number;
  after: string | null;
}>;

export type CatalogSearchResult = Readonly<{
  items: ReadonlyArray<CatalogProduct>;
  endCursor: string | null;
  hasNextPage: boolean;
}>;

export type CatalogProvider = Readonly<{
  providerId: string;
  capabilities: ReadonlyArray<CatalogCapability>;
  outboundHosts: ReadonlyArray<string>;
  search: (input: CatalogSearchInput) => Promise<CatalogSearchResult>;
  getProduct: (id: string) => Promise<CatalogProduct | null>;
  resolveOutboundLink: (id: string) => Promise<string>;
  syncCatalog?: () => Promise<void>;
}>;
