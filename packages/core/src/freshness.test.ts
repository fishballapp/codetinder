import { describe, expect, it } from 'vitest';
import {
  countEligible,
  describeAge,
  freshnessShortfall,
  isResting,
  withinFreshnessBudget,
} from './freshness';

const onQuestion = (id: string, operation = `Change for ${id}`) => ({
  operation,
  principle: { id },
});

const ages = (byId: Record<string, number | null>) =>
  Object.entries(byId).map(([id, roundsSinceJudged]) => ({ id, roundsSinceJudged }));

const idsOf = (cards: readonly { principle: { id: string } }[]) =>
  cards.map(({ principle }) => principle.id);

describe('isResting', () => {
  it('rests ages 0 to 2 and no other', () => {
    expect([0, 1, 2, 3, 4, null].map(isResting)).toEqual([true, true, true, false, false, false]);
  });
});

describe('withinFreshnessBudget', () => {
  it('keeps every card when none rests', () => {
    const cards = ['a', 'b', 'c', 'd'].map(id => onQuestion(id));
    expect(withinFreshnessBudget(cards, ages({ a: 3, b: 9, c: null })).removed).toEqual([]);
  });

  it('takes a new id and a question not judged lately as eligible', () => {
    const cards = ['new', 'lately', 'old', 'r1', 'r2', 'r3'].map(id => onQuestion(id));
    const { kept, removed } = withinFreshnessBudget(
      cards,
      ages({ lately: null, old: 3, r1: 0, r2: 1, r3: 2 }),
    );
    // Three eligible cards allow three resting ones.
    expect(idsOf(removed)).toEqual([]);
    expect(kept).toHaveLength(6);
  });

  it('holds the resting cards to as many as the eligible ones, 2 against 1 removing one', () => {
    const cards = ['r1', 'e1', 'r2'].map(id => onQuestion(id));
    const { kept, removed } = withinFreshnessBudget(cards, ages({ r1: 1, e1: 3, r2: 2 }));
    expect(idsOf(removed)).toEqual(['r1']);
    expect(idsOf(kept)).toEqual(['e1', 'r2']);
  });

  it('is the age boundary that decides: an age of 2 rests, an age of 3 does not', () => {
    const cards = ['x', 'y', 'z'].map(id => onQuestion(id));
    expect(idsOf(withinFreshnessBudget(cards, ages({ x: 2, y: 2, z: 3 })).removed)).toEqual(['y']);
    expect(idsOf(withinFreshnessBudget(cards, ages({ x: 3, y: 3, z: 3 })).removed)).toEqual([]);
  });

  it('removes the most recently judged first, and keeps the order of the rest', () => {
    const cards = ['e1', 'old', 'newest', 'e2', 'mid', 'e3'].map(id => onQuestion(id));
    const { kept, removed } = withinFreshnessBudget(
      cards,
      ages({ old: 2, newest: 0, mid: 1, e1: null, e2: null, e3: null }),
    );
    expect(removed).toEqual([]);
    const crowded = ['old', 'newest', 'e1', 'mid'].map(id => onQuestion(id));
    const result = withinFreshnessBudget(crowded, ages({ old: 2, newest: 0, mid: 1 }));
    expect(idsOf(result.removed)).toEqual(['newest', 'mid']);
    expect(idsOf(result.kept)).toEqual(['old', 'e1']);
    expect(kept).toHaveLength(6);
  });

  it('removes all cards of a resting round when none is eligible', () => {
    const cards = ['a', 'b'].map(id => onQuestion(id));
    expect(withinFreshnessBudget(cards, ages({ a: 0, b: 1 })).kept).toEqual([]);
  });

  it('counts a consistency pair as two cards, dropping its later half first', () => {
    const pair = [onQuestion('pair', 'Inline'), onQuestion('pair', 'Name')];
    const cards = [onQuestion('e1'), ...pair];
    const { kept, removed } = withinFreshnessBudget(cards, ages({ pair: 0 }));
    expect(removed).toEqual([pair[1]]);
    expect(kept).toEqual([cards[0], pair[0]]);
  });
});

describe('countEligible', () => {
  it('counts new ids, ages of 3 or more and null', () => {
    const cards = ['new', 'null', 'three', 'two'].map(id => onQuestion(id));
    expect(countEligible(cards, ages({ null: null, three: 3, two: 2 }))).toBe(3);
  });
});

describe('describeAge', () => {
  it('names the age, or says it was not judged lately', () => {
    expect([describeAge(0), describeAge(5), describeAge(null)]).toEqual([
      'age 0',
      'age 5',
      'not judged lately',
    ]);
  });
});

describe('freshnessShortfall', () => {
  it("says each card's age, the removed ids and how many cards remain", () => {
    const cards = [
      onQuestion('rested', 'Extract Variable'),
      onQuestion('just-judged', 'Inline Variable'),
      onQuestion('just-judged', 'Split Variable'),
      onQuestion('just-judged', 'Rename Variable'),
    ];
    const questions = ages({ rested: 4, 'just-judged': 0 });
    const { kept } = withinFreshnessBudget(cards, questions);
    expect(
      freshnessShortfall({ cards, kept, questions }),
    ).toBe(`Only 2 of your cards remain after the freshness check, and a round needs 3.

A question judged in one of the project's last 3 judged rounds (age 0 to 2) is resting. A round keeps at most as many cards on resting questions as on the rest, and drops the most recently judged first. Your cards:

- Extract Variable: rested, age 4, eligible
- Inline Variable: just-judged, age 0, resting
- Split Variable: just-judged, age 0, resting, removed
- Rename Variable: just-judged, age 0, resting, removed

Removed ids: just-judged
New ids: none
Cards remaining: 2

Pick another changed function whose changes can ask questions that are not resting, and answer for it. Don't relabel a resting idea under a new id: a card on the same idea counts as resting.`);
  });

  it('names the ids no earlier card used as new', () => {
    const cards = [onQuestion('brand-new'), onQuestion('just-judged'), onQuestion('just-judged')];
    const questions = ages({ 'just-judged': 1 });
    const { kept } = withinFreshnessBudget(cards, questions);
    const message = freshnessShortfall({ cards, kept, questions });
    expect(message).toContain('- Change for brand-new: brand-new, a new id\n');
    expect(message).toContain('New ids: brand-new\n');
  });
});
