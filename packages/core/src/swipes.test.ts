import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { evidence, tallyVerdicts, VerdictsSchema } from './swipes';

describe('VerdictsSchema', () => {
  const decode = Schema.decodeUnknownResult(VerdictsSchema);

  it('takes one like or dislike per card id', () => {
    expect(decode({ c1: 'like', c2: 'dislike' })).toEqual(
      Result.succeed({ c1: 'like', c2: 'dislike' }),
    );
  });

  it('rejects any other verdict', () => {
    expect(Result.isFailure(decode({ c1: 'meh' }))).toBe(true);
  });

  it('rejects the old list shape', () => {
    expect(Result.isFailure(decode([{ variantId: 'v1', verdict: 'like' }]))).toBe(true);
  });
});

const card = (id: string) => ({
  id,
  operation: 'Rename Variable',
  change: 'Renamed a variable.',
  principle: { id: 'clear-names', statement: 'Name variables for what they hold.' },
  stance: 'supports' as const,
  kind: 'explore' as const,
  after: id,
});

describe('tallyVerdicts', () => {
  it("counts every developer's verdict per card, in round order", () => {
    expect(
      tallyVerdicts({ cards: ['c1', 'c2', 'c3'].map(card) }, [
        { verdicts: { c1: 'like', c2: 'dislike' } },
        { verdicts: { c1: 'like', c2: 'like' } },
        { verdicts: { c3: 'dislike' } },
      ]).map(({ card, likes, dislikes }) => [card.id, likes, dislikes]),
    ).toEqual([
      ['c1', 2, 0],
      ['c2', 1, 1],
      ['c3', 0, 1],
    ]);
  });
});

describe('evidence', () => {
  it('counts a like for the principle on a card that supports it', () => {
    expect(evidence({ stance: 'supports', likes: 3, dislikes: 1 })).toEqual({ for: 3, against: 1 });
  });

  it('counts a like against the principle on a card that opposes it', () => {
    expect(evidence({ stance: 'opposes', likes: 3, dislikes: 1 })).toEqual({ for: 1, against: 3 });
  });
});
