import { describe, expect, it } from 'vitest';
import { principleEvidence, testedPrinciples } from './principle-evidence';
import type { Card, Round } from './round';

const card = (id: string, principleId: string, stance: Card['stance'], after: string): Card => ({
  id,
  operation: 'Extract Variable',
  change: 'Names a value.',
  principle: { id: principleId, statement: 'Name values.' },
  stance,
  kind: 'explore',
  after,
});

const roundOf = (cards: readonly Card[]): Pick<Round, 'cards' | 'target'> => ({
  target: { file: 'src/f.ts', symbol: 'f', text: 'f()' },
  cards,
});

const older = roundOf([
  card('c1', 'name-values', 'supports', 'const x = f()'),
  card('c2', 'name-values', 'opposes', 'g(f())'),
]);
const newer = roundOf([
  card('c1', 'name-values', 'supports', 'const y = f()'),
  card('c2', 'early-returns', 'supports', 'if (!x) return'),
]);

describe('testedPrinciples', () => {
  it("is the ids a round's cards test", () => {
    expect(testedPrinciples(newer)).toEqual(new Set(['name-values', 'early-returns']));
  });
});

describe('principleEvidence', () => {
  const rounds = [
    { id: 'NEWER', round: newer, swipes: [{ verdicts: { c1: 'like', c2: 'dislike' } as const }] },
    { id: 'OLDER', round: older, swipes: [{ verdicts: { c1: 'dislike', c2: 'like' } as const }] },
  ];

  it('tallies every verdict for and against, and cites the newest card each way', () => {
    expect(principleEvidence({ principleIds: new Set(['name-values']), rounds })).toEqual([
      {
        id: 'name-values',
        // NEWER/c1 liked, a supporting card: for. OLDER/c1 disliked: against. OLDER/c2, an opposing
        // card liked: against.
        for: 1,
        against: 2,
        confirming: {
          ref: 'NEWER/c1',
          file: 'src/f.ts',
          operation: 'Extract Variable',
          change: 'Names a value.',
          diff: '@@ -1,1 +1,1 @@\n-f()\n+const y = f()',
          likes: 1,
          dislikes: 0,
        },
        contradicting: {
          ref: 'OLDER/c1',
          file: 'src/f.ts',
          operation: 'Extract Variable',
          change: 'Names a value.',
          diff: '@@ -1,1 +1,1 @@\n-f()\n+const x = f()',
          likes: 0,
          dislikes: 1,
        },
      },
    ]);
  });

  it('has nothing on a principle no earlier verdict bears on', () => {
    const unswiped = [{ id: 'OLDER', round: older, swipes: [{ verdicts: {} }] }];
    expect(
      principleEvidence({ principleIds: new Set(['name-values', 'unseen']), rounds: unswiped }),
    ).toEqual([]);
  });
});
