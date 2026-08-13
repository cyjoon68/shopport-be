import { getKstUsageDate, reserveQuota } from './quota.js';

describe('quota', () => {
  it('uses the KST calendar date around UTC rollover', () => {
    expect(getKstUsageDate(new Date('2026-08-12T14:59:59.000Z'))).toBe(
      '2026-08-12',
    );
    expect(getKstUsageDate(new Date('2026-08-12T15:00:00.000Z'))).toBe(
      '2026-08-13',
    );
  });

  it('counts an image and text turn only as image usage', () => {
    expect(
      reserveQuota(
        { textCount: 10, imageCount: 1 },
        { hasText: true, hasImage: true },
        'trial',
      ),
    ).toEqual({ textCount: 10, imageCount: 2 });
  });

  it('rejects a trial text turn above the daily quota', () => {
    expect(() =>
      reserveQuota(
        { textCount: 10, imageCount: 0 },
        { hasText: true, hasImage: false },
        'trial',
      ),
    ).toThrow('QUOTA_EXCEEDED');
  });
});
