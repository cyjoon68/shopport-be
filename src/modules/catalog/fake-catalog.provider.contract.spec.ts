import { FakeCatalogProvider } from './fake-catalog.provider.js';
import { rankProducts } from './neutral-ranking.js';

describe('Fake catalog provider contract', () => {
  it('supports live search, stable lookup, allowlisted links, and neutral ordering', async () => {
    const provider = new FakeCatalogProvider();
    expect(provider.capabilities).toContain('LIVE_QUERY');
    const result = await provider.search({ query: '', first: 4, after: null });
    expect(result.items).toEqual(rankProducts(result.items));
    expect(result.items).toHaveLength(4);
    for (const item of result.items) {
      await expect(provider.getProduct(item.id)).resolves.toEqual(item);
      const outbound = new URL(await provider.resolveOutboundLink(item.id));
      expect(provider.outboundHosts).toContain(outbound.hostname);
    }
  });
});
