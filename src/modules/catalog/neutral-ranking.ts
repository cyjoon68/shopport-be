import type { CatalogProduct } from './types.js';

const compareBooleanDesc = (left: boolean, right: boolean): number =>
  Number(right) - Number(left);

const compareNumberDesc = (left: number, right: number): number => right - left;

const compareNullableNumberAsc = (
  left: number | null,
  right: number | null,
): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return left - right;
};

const compareMoneyAsc = (left: string, right: string): number => {
  const leftAmount = BigInt(left);
  const rightAmount = BigInt(right);
  if (leftAmount < rightAmount) return -1;
  if (leftAmount > rightAmount) return 1;
  return 0;
};

const compareProduct = (left: CatalogProduct, right: CatalogProduct): number =>
  compareNumberDesc(left.relevanceBucket, right.relevanceBucket) ||
  compareBooleanDesc(left.inStock, right.inStock) ||
  compareMoneyAsc(left.totalAmountMinor, right.totalAmountMinor) ||
  compareNullableNumberAsc(
    left.deliveryEstimateDays,
    right.deliveryEstimateDays,
  ) ||
  compareNumberDesc(left.ratingConfidence, right.ratingConfidence) ||
  compareNumberDesc(left.freshnessEpochMs, right.freshnessEpochMs) ||
  left.id.localeCompare(right.id);

export const rankProducts = (
  products: ReadonlyArray<CatalogProduct>,
): ReadonlyArray<CatalogProduct> => [...products].sort(compareProduct);
