import { describe, expect, it } from '@jest/globals';
import {
  evaluateShoppingDeepMode,
  shoppingAmbiguityThreshold,
} from './shopping-deep-mode.js';

describe('shopping deep mode', () => {
  it('keeps the LLM-selected question when its ambiguity exceeds the gate', () => {
    expect(
      evaluateShoppingDeepMode({
        requestKind: 'shopping',
        goalClarity: 0.6,
        constraintClarity: 0,
        successCriteriaClarity: 0,
        nextDimension: 'purpose',
      }),
    ).toEqual({
      requestKind: 'shopping',
      ambiguityScore: 0.76,
      clarificationDimension: 'purpose',
    });
  });

  it('clears the question once the LLM reaches the convergence threshold', () => {
    const assessment = evaluateShoppingDeepMode({
      requestKind: 'shopping',
      goalClarity: 1,
      constraintClarity: 1,
      successCriteriaClarity: 0.5,
      nextDimension: 'budget',
    });

    expect(assessment.ambiguityScore).toBeLessThanOrEqual(
      shoppingAmbiguityThreshold,
    );
    expect(assessment.clarificationDimension).toBeNull();
  });

  it('keeps non-shopping requests outside the ambiguity gate', () => {
    expect(
      evaluateShoppingDeepMode({
        requestKind: 'other',
        goalClarity: 1,
        constraintClarity: 1,
        successCriteriaClarity: 1,
        nextDimension: null,
      }),
    ).toEqual({
      requestKind: 'other',
      ambiguityScore: null,
      clarificationDimension: null,
    });
  });
});
