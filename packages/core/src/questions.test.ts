import { describe, expect, it } from 'vitest';
import { questionsOf } from './questions';
import type { Stance } from './round';

const card = (id: string, principleId: string, stance: Stance, statement = `${principleId}.`) => ({
  id,
  operation: 'Extract Function',
  change: 'Extracted a helper.',
  principle: { id: principleId, statement },
  stance,
  kind: 'explore' as const,
  after: id,
});

const agesOf = (rounds: Parameters<typeof questionsOf>[0]) =>
  Object.fromEntries(
    questionsOf(rounds).map(({ id, roundsSinceJudged }) => [id, roundsSinceJudged]),
  );

describe('questionsOf', () => {
  it('counts every verdict on a principle across rounds, by the stance of its cards', () => {
    expect(
      questionsOf([
        {
          round: {
            cards: [card('c1', 'small-functions', 'supports'), card('c2', 'guards', 'opposes')],
          },
          swipes: [{ verdicts: { c1: 'like', c2: 'like' } }, { verdicts: { c1: 'dislike' } }],
        },
        {
          round: { cards: [card('c1', 'small-functions', 'opposes')] },
          swipes: [{ verdicts: { c1: 'dislike' } }],
        },
      ]),
    ).toEqual([
      {
        id: 'small-functions',
        statement: 'small-functions.',
        supports: { likes: 1, dislikes: 1 },
        opposes: { likes: 0, dislikes: 1 },
        roundsSinceJudged: 0,
      },
      {
        id: 'guards',
        statement: 'guards.',
        supports: { likes: 0, dislikes: 0 },
        opposes: { likes: 1, dislikes: 0 },
        roundsSinceJudged: 0,
      },
    ]);
  });

  it("states a question as its newest round's card does, and keeps one nobody swiped", () => {
    expect(
      questionsOf([
        { round: { cards: [card('c1', 'guards', 'supports', 'Return early.')] }, swipes: [] },
        { round: { cards: [card('c1', 'guards', 'supports', 'Guard first.')] }, swipes: [] },
      ]),
    ).toEqual([
      {
        id: 'guards',
        statement: 'Return early.',
        supports: { likes: 0, dislikes: 0 },
        opposes: { likes: 0, dislikes: 0 },
        roundsSinceJudged: null,
      },
    ]);
  });

  describe('roundsSinceJudged', () => {
    const judged = (principleId: string) => ({
      round: { cards: [card('c1', principleId, 'supports')] },
      swipes: [{ verdicts: { c1: 'like' as const } }],
    });
    const unswiped = (principleId: string) => ({
      round: { cards: [card('c1', principleId, 'supports')] },
      swipes: [],
    });

    it('is 0 for the newest judged round and counts judged rounds back from it', () => {
      expect(agesOf([judged('a'), judged('b'), judged('c'), judged('d')])).toEqual({
        a: 0,
        b: 1,
        c: 2,
        d: 3,
      });
    });

    it('skips rounds nobody judged, whichever the swipes they hold', () => {
      expect(
        agesOf([
          unswiped('new'),
          { ...unswiped('empty'), swipes: [{ verdicts: {} }] },
          judged('a'),
          unswiped('old'),
          judged('b'),
        ]),
      ).toEqual({ new: null, empty: null, a: 0, old: null, b: 1 });
    });

    it('is the newest round that judged the question, when several did', () => {
      expect(agesOf([judged('a'), judged('b'), judged('a')])).toEqual({ a: 0, b: 1 });
      expect(agesOf([judged('b'), judged('a'), judged('a')])).toEqual({ b: 0, a: 1 });
    });

    it('rests only the questions whose own card got a verdict in a deck swiped in part', () => {
      expect(
        agesOf([
          {
            round: {
              cards: [card('c1', 'swiped', 'supports'), card('c2', 'unseen', 'supports')],
            },
            swipes: [{ verdicts: { c1: 'dislike' } }],
          },
          judged('swiped-earlier'),
          judged('unseen'),
        ]),
      ).toEqual({ swiped: 0, unseen: 2, 'swiped-earlier': 1 });
    });

    it('counts a verdict by any teammate, and is null for a question never judged', () => {
      expect(
        agesOf([
          {
            round: { cards: [card('c1', 'a', 'supports'), card('c2', 'b', 'supports')] },
            swipes: [{ verdicts: {} }, { verdicts: { c2: 'like' } }],
          },
        ]),
      ).toEqual({ a: null, b: 0 });
    });

    it('is 0 and the question judged whatever its stance, with no rounds read otherwise', () => {
      expect(questionsOf([])).toEqual([]);
      expect(
        agesOf([
          {
            round: { cards: [card('c1', 'a', 'opposes')] },
            swipes: [{ verdicts: { c1: 'dislike' } }],
          },
        ]),
      ).toEqual({ a: 0 });
    });
  });
});
