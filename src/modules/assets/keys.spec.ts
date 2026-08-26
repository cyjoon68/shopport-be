import { assetKeysFor, parseNormalizedAssetKey } from './keys.js';

describe('assetKeysFor', () => {
  it('builds stable storage keys for an account and asset', () => {
    expect(
      assetKeysFor(
        '0198a122-0c00-7000-8000-000000000001',
        '0198a122-0c00-7000-8000-000000000002',
      ),
    ).toEqual({
      original:
        'uploads/0198a122-0c00-7000-8000-000000000001/0198a122-0c00-7000-8000-000000000002/original',
      normalized:
        'uploads/0198a122-0c00-7000-8000-000000000001/0198a122-0c00-7000-8000-000000000002/normalized.jpg',
    });
  });
});

describe('parseNormalizedAssetKey', () => {
  const accountId = '0198a122-0c00-7000-8000-000000000001';
  const assetId = '0198a122-0c00-7000-8000-000000000002';

  it('returns the account ID for the exact normalized asset key', () => {
    expect(
      parseNormalizedAssetKey(
        `uploads/${accountId}/${assetId}/normalized.jpg`,
        assetId,
      ),
    ).toBe(accountId);
  });

  it.each([
    `uploads/${accountId}/0198a122-0c00-7000-8000-000000000003/normalized.jpg`,
    `uploads/not-a-uuid/${assetId}/normalized.jpg`,
    `uploads/${accountId}/${assetId}/original`,
    `prefix/uploads/${accountId}/${assetId}/normalized.jpg`,
    `uploads/${accountId}/${assetId}/normalized.jpg/extra`,
  ])('rejects an unowned or malformed normalized key: %s', (key) => {
    expect(() => parseNormalizedAssetKey(key, assetId)).toThrow();
  });
});
