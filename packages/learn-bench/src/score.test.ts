import type { Principle, Strength } from '@codetinder/core';
import { describe, expect, it } from 'vitest';
import type { JudgedCard } from './record';
import { churnOf, scorePredictions, sizeOf } from './score';

const card = (truth: JudgedCard['truth'], prediction: JudgedCard['prediction']): JudgedCard => ({
  cardId: 'c1',
  truth,
  prediction,
  principleId: null,
  isRuleCard: false,
});

const principle = (id: string, strength: Strength, statement = `Do ${id}.`): Principle => ({
  id,
  section: 'General',
  strength,
  statement,
});

describe('scorePredictions', () => {
  it('counts an abstention as neither right nor wrong, and a wrong guess against the net', () => {
    expect(
      scorePredictions([
        card('like', 'like'),
        card('dislike', 'dislike'),
        card('like', 'dislike'),
        card('dislike', 'none'),
      ]),
    ).toEqual({
      correct: 2,
      wrong: 1,
      abstained: 1,
      accuracy: 2 / 3,
      coverage: 3 / 4,
      net: 1 / 4,
    });
  });

  it('scores no cards as zero', () => {
    expect(scorePredictions([])).toEqual({
      correct: 0,
      wrong: 0,
      abstained: 0,
      accuracy: 0,
      coverage: 0,
      net: 0,
    });
  });
});

describe('churnOf', () => {
  it('counts a strength that turns back, not one that keeps climbing', () => {
    const climbing = [
      [principle('a', 'tentative')],
      [principle('a', 'moderate')],
      [principle('a', 'strong')],
    ];
    const turning = [
      [principle('a', 'tentative')],
      [principle('a', 'moderate')],
      [principle('a', 'tentative')],
    ];
    expect(churnOf(climbing).flipFlops).toBe(0);
    expect(churnOf(turning).flipFlops).toBe(1);
  });

  it('counts a principle dropped and added again, but not its first addition', () => {
    const docs = [[], [principle('a', 'tentative')], [], [principle('a', 'tentative')]];
    expect(churnOf(docs).readded).toBe(1);
  });

  it('counts each rewording of a statement', () => {
    const docs = [
      [principle('a', 'tentative', 'One.')],
      [principle('a', 'tentative', 'Two.')],
      [principle('a', 'moderate', 'Two.')],
    ];
    expect(churnOf(docs).rewordings).toBe(1);
  });
});

describe('sizeOf', () => {
  it('counts the exceptions each statement carves out', () => {
    const size = sizeOf([
      principle('a', 'strong', 'Name values, unless they are used once, except in tests.'),
      principle('b', 'strong', 'Use guard clauses.'),
    ]);
    expect(size.qualifiersPerPrinciple).toBe(1);
    expect(size.maxQualifiers).toBe(2);
    expect(size.principles).toBe(2);
  });
});
