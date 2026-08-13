export type AccessTier = 'trial' | 'pro';

export type Usage = Readonly<{
  textCount: number;
  imageCount: number;
}>;

export type TurnMedia = Readonly<{
  hasText: boolean;
  hasImage: boolean;
}>;

const quotaByTier = {
  trial: { text: 10, image: 2 },
  pro: { text: 50, image: 10 },
} as const satisfies Record<AccessTier, { text: number; image: number }>;

export class QuotaExceededError extends Error {
  public constructor() {
    super('QUOTA_EXCEEDED');
    this.name = 'QuotaExceededError';
  }
}

export const getKstUsageDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

export const reserveQuota = (
  current: Usage,
  turn: TurnMedia,
  tier: AccessTier,
): Usage => {
  const limit = quotaByTier[tier];
  if (turn.hasImage) {
    if (current.imageCount >= limit.image) throw new QuotaExceededError();
    return { ...current, imageCount: current.imageCount + 1 };
  }
  if (turn.hasText) {
    if (current.textCount >= limit.text) throw new QuotaExceededError();
    return { ...current, textCount: current.textCount + 1 };
  }
  return current;
};
