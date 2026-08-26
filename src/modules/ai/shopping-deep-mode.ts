import type { ClarificationDimension } from './types.js';

export const shoppingAmbiguityThreshold = 0.2;
export const shoppingRequestKinds = ['shopping', 'other'] as const;

type ShoppingRequestKind = (typeof shoppingRequestKinds)[number];

export type ShoppingDeepModeAssessment = Readonly<{
  requestKind: ShoppingRequestKind;
  ambiguityScore: number | null;
  clarificationDimension: ClarificationDimension | null;
}>;

type ShoppingDeepModeInput = Readonly<{
  requestKind: ShoppingRequestKind;
  goalClarity: number;
  constraintClarity: number;
  successCriteriaClarity: number;
  nextDimension: ClarificationDimension | null;
}>;

export const evaluateShoppingDeepMode = (
  input: ShoppingDeepModeInput,
): ShoppingDeepModeAssessment => {
  if (input.requestKind === 'other') {
    return {
      requestKind: input.requestKind,
      ambiguityScore: null,
      clarificationDimension: null,
    };
  }
  const ambiguityScore =
    1 -
    (input.goalClarity * 0.4 +
      input.constraintClarity * 0.3 +
      input.successCriteriaClarity * 0.3);
  return {
    requestKind: input.requestKind,
    ambiguityScore,
    clarificationDimension:
      ambiguityScore > shoppingAmbiguityThreshold ? input.nextDimension : null,
  };
};
