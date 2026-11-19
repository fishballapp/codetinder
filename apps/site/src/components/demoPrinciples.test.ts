import type { Card, Verdict } from '@codetinder/core';
import { describe, expect, it } from 'vitest';
import {
  applyVerdict,
  type DemoScores,
  demoPrinciples,
  NO_SCORES,
  principleSwayedBy,
} from './demoPrinciples';
import { DEMO_ROUND } from './demoRound';

const demoCard = (id: string): Card => {
  const card = DEMO_ROUND.cards.find(candidate => candidate.id === id);
  if (!card) throw new Error(`no demo card ${id}`);
  return card;
};
const pipeline = demoCard('c1');
const descriptive = demoCard('c2');
const arrow = demoCard('c4');
const terse = demoCard('c6');

const swipe = (swipes: readonly (readonly [Card, Verdict])[]): DemoScores =>
  swipes.reduce<DemoScores>(
    (scores, [card, verdict]) => applyVerdict(scores, card, verdict),
    NO_SCORES,
  );

const read = (scores: DemoScores) =>
  demoPrinciples(scores).map(({ id, strength }) => [id, strength]);

describe('DEMO_ROUND', () => {
  it('changes the function once per card', () => {
    for (const card of DEMO_ROUND.cards) expect(card.after).not.toBe(DEMO_ROUND.target.text);
  });

  it('has one consistency pair, on one principle with opposite stances', () => {
    const pair = DEMO_ROUND.cards.filter(({ kind }) => kind === 'consistency');

    expect(pair.map(({ principle }) => principle.id)).toEqual([
      'descriptive-names',
      'descriptive-names',
    ]);
    expect(pair.map(({ stance }) => stance)).toEqual(['supports', 'opposes']);
  });
});

describe('demoPrinciples', () => {
  it('says nothing before any swipe', () => {
    expect(demoPrinciples(NO_SCORES)).toEqual([]);
  });

  it('learns a principle from a like on a card that supports it', () => {
    expect(read(swipe([[pipeline, 'like']]))).toEqual([['pipelines-over-loops', 'tentative']]);
  });

  it('learns the opposite from a like on a card that opposes a principle', () => {
    expect(read(swipe([[arrow, 'like']]))).toEqual([['arrow-functions', 'tentative']]);
  });

  it('firms up a principle the consistency pair agrees on', () => {
    expect(
      read(
        swipe([
          [descriptive, 'like'],
          [terse, 'dislike'],
        ]),
      ),
    ).toEqual([['descriptive-names', 'moderate']]);
  });

  it('learns nothing from a pair swiped the same way', () => {
    expect(
      read(
        swipe([
          [descriptive, 'like'],
          [terse, 'like'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('principleSwayedBy', () => {
  it("names the card's principle as the doc now reads it", () => {
    const scores = applyVerdict(NO_SCORES, pipeline, 'dislike');

    expect(principleSwayedBy(NO_SCORES, scores, pipeline)).toBe('plain-loops');
  });

  it('names the principle a swipe cancels out', () => {
    const liked = applyVerdict(NO_SCORES, descriptive, 'like');
    const cancelled = applyVerdict(liked, terse, 'like');

    expect(principleSwayedBy(liked, cancelled, terse)).toBe('descriptive-names');
  });
});
