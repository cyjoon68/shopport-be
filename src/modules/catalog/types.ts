type CatalogCapability = 'LIVE_QUERY' | 'LICENSED_FEED';

export type StockAvailability = 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';

export type CatalogProduct = Readonly<{
  id: string;
  providerId: string;
  productCode: string;
  title: string;
  imageUrl: string;
  affiliate: boolean;
  relevanceBucket: number;
  inStock: boolean;
  availability: StockAvailability;
  totalAmountMinor: string;
  deliveryEstimateDays: number | null;
  ratingConfidence: number;
  freshnessEpochMs: number;
  outboundUrl: string;
  store: Readonly<{
    code: string;
    name: string;
    address: string;
    distance: string | null;
  }> | null;
  inventory: Readonly<{
    status: 'in_stock' | 'out_of_stock' | 'unconfirmed';
    quantity: number | null;
    location: string;
  }> | null;
  evidence: ReadonlyArray<
    Readonly<{
      operation: 'products' | 'inventory';
      fetchedAt: number;
    }>
  >;
}>;

export type CatalogSearchInput = Readonly<{
  query: string;
  first: number;
  after: string | null;
  providerId?: 'daiso' | 'oliveyoung';
  budgetMax?: number;
  location?: string;
}>;

export type CatalogSearchResult = Readonly<{
  items: ReadonlyArray<CatalogProduct>;
  endCursor: string | null;
  hasNextPage: boolean;
  unavailableProviderIds: ReadonlyArray<string>;
}>;

export type CatalogProvider = Readonly<{
  providerId: string;
  capabilities: ReadonlyArray<CatalogCapability>;
  outboundHosts: ReadonlyArray<string>;
  search: (input: CatalogSearchInput) => Promise<CatalogSearchResult>;
  syncCatalog?: () => Promise<void>;
}>;
