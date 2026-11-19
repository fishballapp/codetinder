import * as Result from 'effect/Result';
import { describe, expect, it } from 'vitest';
import {
  applyLearnAnswer,
  applyOperations,
  citationsOf,
  evidenceOnDoc,
  MAX_RULES,
  type Operation,
} from './learn-operations';
import { type PrincipleEvidence, principleEvidence, testedPrinciples } from './principle-evidence';
import type { Principle } from './principles';
import type { Card, Round } from './round';
import { evidence as evidenceOf, tallyVerdicts } from './swipes';

const doc: Principle[] = [
  { id: 'early-returns', section: 'General', strength: 'moderate', statement: 'Return early.' },
  { id: 'name-values', section: 'General', strength: 'tentative', statement: 'Name values.' },
  { id: 'arrows', section: 'TypeScript', strength: 'strong', statement: 'Use arrows.' },
];

const inline = { id: 'inline-single-use', strength: 'tentative', statement: 'Inline one use.' };
const withException: Principle[] = [{ ...doc[0], exception: inline } as Principle, ...doc.slice(1)];

const none = new Map<string, number>();
const apply = (
  principles: readonly Principle[],
  operations: readonly Operation[],
  citations = none,
) => applyOperations(principles, operations, citations);

const strengthOf = (principles: readonly Principle[], id: string) =>
  principles.find(principle => principle.id === id)?.strength;

const reasons = ({ skipped }: { skipped: readonly { reason: string }[] }) =>
  skipped.map(({ reason }) => reason);

describe('applyOperations', () => {
  it('keeps every principle no operation names', () => {
    expect(apply(doc, [])).toEqual({ principles: doc, skipped: [] });
  });

  it('moves a strength one step, keeping strong strong, and drops a tentative one weakened', () => {
    const { principles } = apply(doc, [
      { op: 'strengthen', id: 'early-returns' },
      { op: 'strengthen', id: 'arrows' },
      { op: 'weaken', id: 'name-values' },
    ]);
    expect(strengthOf(principles, 'early-returns')).toBe('strong');
    expect(strengthOf(principles, 'arrows')).toBe('strong');
    expect(principles.map(({ id }) => id)).toEqual(['early-returns', 'arrows']);
  });

  it('adds a new principle as tentative, at the end', () => {
    const { principles } = apply(doc, [
      { op: 'add', id: 'small-functions', section: 'General', statement: 'Keep functions small.' },
    ]);
    expect(principles.at(-1)).toEqual({
      id: 'small-functions',
      section: 'General',
      strength: 'tentative',
      statement: 'Keep functions small.',
    });
  });

  it('merges principles into the one that stays, with its strength and the new statement', () => {
    const { principles } = apply(doc, [
      { op: 'merge', id: 'early-returns', merged: ['name-values'], statement: 'Return early.' },
    ]);
    expect(principles).toEqual([{ ...doc[0], statement: 'Return early.' }, doc[2]]);
  });

  it('rewords a statement and its section, keeping its strength and place', () => {
    const { principles } = apply(doc, [
      { op: 'reword', id: 'early-returns', section: 'TypeScript', statement: 'Guard first.' },
    ]);
    expect(principles[0]).toEqual({
      id: 'early-returns',
      section: 'TypeScript',
      strength: 'moderate',
      statement: 'Guard first.',
    });
  });

  it('skips an operation on a missing id, an add of an existing one, and a second on a principle', () => {
    const answered = apply(doc, [
      { op: 'drop', id: 'nowhere' },
      { op: 'add', id: 'arrows', section: 'General', statement: 'Again.' },
      { op: 'strengthen', id: 'early-returns' },
      { op: 'drop', id: 'early-returns' },
    ]);
    expect(strengthOf(answered.principles, 'early-returns')).toBe('strong');
    expect(reasons(answered)).toEqual([
      '"nowhere" is not in the doc',
      '"arrows" is already in the doc',
      '"early-returns" already has an operation this round',
    ]);
  });

  it('skips a merge naming the principle that stays, or one already acted on', () => {
    const answered = apply(doc, [
      { op: 'strengthen', id: 'name-values' },
      { op: 'merge', id: 'early-returns', merged: ['name-values'], statement: 'X.' },
      { op: 'merge', id: 'arrows', merged: ['arrows'], statement: 'X.' },
    ]);
    expect(reasons(answered)).toEqual([
      '"name-values" already has an operation this round',
      '"arrows" already has an operation this round',
    ]);
  });

  it('applies at most 4 operations, in the order given', () => {
    const adds = ['a', 'b', 'c', 'd', 'e'].map(id => ({
      op: 'add' as const,
      id,
      section: 'General' as const,
      statement: 'X.',
    }));
    const { principles, skipped } = apply([], adds);
    expect(principles.map(({ id }) => id)).toEqual(['a', 'b', 'c', 'd']);
    expect(skipped).toEqual([{ operation: adds[4], reason: 'a round makes at most 4 operations' }]);
  });
});

describe('narrowing', () => {
  const narrow = (overrides: Partial<Extract<Operation, { op: 'narrow' }>> = {}): Operation => ({
    op: 'narrow',
    id: 'early-returns',
    exception: { id: 'inline-single-use', statement: 'Inline one use.' },
    difference: 'The contradicting cards return a value used once.',
    confirming: ['c1'],
    contradicting: ['c2', 'EARLIER/c3'],
    ...overrides,
  });
  const citations = new Map([
    ['c1', 1],
    ['c2', 1],
    ['EARLIER/c3', 1],
  ]);

  it('adds a tentative exception under the principle, which keeps its strength', () => {
    const { principles, skipped } = apply(doc, [narrow()], citations);
    expect(skipped).toEqual([]);
    expect(principles[0]).toEqual({ ...doc[0], exception: inline });
  });

  it('skips a narrow backed by fewer than 2 swipes against the principle', () => {
    expect(reasons(apply(doc, [narrow({ contradicting: ['c2'] })], citations))).toEqual([
      'the cards it cites against the principle hold 1 swipe; an exception needs 2',
    ]);
  });

  it('counts a card cited twice against the principle once', () => {
    expect(reasons(apply(doc, [narrow({ contradicting: ['c2', 'c2'] })], citations))).toEqual([
      'the cards it cites against the principle hold 1 swipe; an exception needs 2',
    ]);
  });

  it('skips a narrow citing one card both for and against the principle', () => {
    expect(
      reasons(
        apply(
          doc,
          [narrow({ confirming: ['c2'], contradicting: ['c2', 'EARLIER/c3'] })],
          citations,
        ),
      ),
    ).toEqual(['it cites "c2" both for and against the principle']);
  });

  it("skips a merge that would take another principle's exception, or drop one's own", () => {
    const merge = (merged: string[]): Operation => ({
      op: 'merge',
      id: 'name-values',
      merged,
      statement: 'Z.',
    });
    expect(reasons(apply(withException, [merge(['inline-single-use'])]))).toEqual([
      '"inline-single-use" is another principle\'s exception',
    ]);
    expect(reasons(apply(withException, [merge(['early-returns'])]))).toEqual([
      '"early-returns" holds an exception: merge that into it, restated, first',
    ]);
    const { principles, skipped } = apply(withException, [
      merge(['early-returns', 'inline-single-use']),
    ]);
    expect(skipped).toEqual([]);
    expect(principles.map(({ id }) => id)).toEqual(['name-values', 'arrows']);
  });

  it('skips an operation on an exception whose principle the round removed', () => {
    const { principles, skipped } = apply(withException, [
      { op: 'strengthen', id: 'inline-single-use' },
      { op: 'drop', id: 'early-returns' },
    ]);
    expect(principles).toEqual(doc.slice(1));
    expect(reasons({ skipped })).toEqual([
      '"inline-single-use" went with its principle, removed this round',
    ]);
  });

  it('skips a narrow citing a card learn was not shown, or none that confirms it', () => {
    expect(reasons(apply(doc, [narrow({ contradicting: ['c2', 'c9'] })], citations))).toEqual([
      'it cites "c9", which is no card learn was shown',
    ]);
    expect(reasons(apply(doc, [narrow({ confirming: [] })], citations))).toEqual([
      'it cites no card that confirms the principle',
    ]);
  });

  it('holds one exception per principle, and none on an exception', () => {
    const second = narrow({ exception: { id: 'other', statement: 'X.' } });
    expect(reasons(apply(withException, [second], citations))).toEqual([
      '"early-returns" holds an exception already: merge it into the principle, restated, first',
    ]);
    expect(
      reasons(
        apply(
          withException,
          [narrow({ id: 'inline-single-use', exception: { id: 'x', statement: 'X.' } })],
          citations,
        ),
      ),
    ).toEqual(['"inline-single-use" is an exception: restate its principle instead']);
  });

  it('acts on an exception by its id, and drops it with its principle', () => {
    expect(
      apply(withException, [{ op: 'strengthen', id: 'inline-single-use' }]).principles[0]?.exception
        ?.strength,
    ).toBe('moderate');
    expect(apply(withException, [{ op: 'weaken', id: 'inline-single-use' }]).principles[0]).toEqual(
      doc[0],
    );
    expect(apply(withException, [{ op: 'drop', id: 'early-returns' }]).principles).toEqual(
      doc.slice(1),
    );
  });

  it('restates a principle by merging its exception into it', () => {
    const { principles } = apply(withException, [
      {
        op: 'merge',
        id: 'early-returns',
        merged: ['inline-single-use'],
        statement: 'Return early, except for a value used once.',
      },
    ]);
    expect(principles[0]).toEqual({
      ...doc[0],
      statement: 'Return early, except for a value used once.',
    });
  });

  it('keeps an exception in its principle section when reworded', () => {
    const reworded = (section: 'General' | 'TypeScript') =>
      apply(withException, [{ op: 'reword', id: 'inline-single-use', section, statement: 'Y.' }]);
    expect(reworded('General').principles[0]?.exception?.statement).toBe('Y.');
    expect(reasons(reworded('TypeScript'))).toEqual([
      '"inline-single-use" is an exception: it stays in its principle\'s section',
    ]);
  });
});

describe('the doc cap', () => {
  const full: Principle[] = Array.from({ length: MAX_RULES }, (_, index) => ({
    id: `p${index}`,
    section: 'General',
    strength: 'tentative',
    statement: 'X.',
  }));
  const add: Operation = { op: 'add', id: 'new', section: 'General', statement: 'Y.' };

  it('skips an add to a full doc', () => {
    expect(reasons(apply(full, [add]))).toEqual([
      `the doc holds ${MAX_RULES} principles, and ${MAX_RULES} at most: drop or merge to make room first`,
    ]);
  });

  it('adds once the same round drops one, whatever the answer order', () => {
    const { principles, skipped } = apply(full, [add, { op: 'drop', id: 'p0' }]);
    expect(skipped).toEqual([]);
    expect(principles.at(-1)?.id).toBe('new');
  });
});

describe('citations', () => {
  const card = { id: 'c1' } as Card;
  const earlier = {
    ref: 'EARLIER/c3',
    file: 'f.ts',
    operation: 'Extract Variable',
    change: 'Names it.',
    diff: '',
    likes: 2,
    dislikes: 1,
  };
  const evidence: PrincipleEvidence[] = [
    { id: 'early-returns', for: 2, against: 1, confirming: earlier, contradicting: null },
    {
      id: 'off-doc',
      for: 1,
      against: 0,
      confirming: { ...earlier, ref: 'OFF/c1' },
      contradicting: null,
    },
  ];
  const current = { _tag: 'Parsed', principles: doc, isNormalised: true } as const;

  it("are this round's swiped cards and the earlier cards learn was shown, with the swipes that don't cancel out", () => {
    expect(
      citationsOf({
        tallies: [
          { card, likes: 1, dislikes: 0 },
          { card: { ...card, id: 'c2' }, likes: 0, dislikes: 0 },
          { card: { ...card, id: 'c3' }, likes: 1, dislikes: 1 },
        ],
        evidence: evidenceOnDoc(current, evidence),
      }),
    ).toEqual(
      new Map([
        ['c1', 1],
        ['c3', 0],
        ['EARLIER/c3', 1],
      ]),
    );
  });

  it('show evidence only on principles of the doc, and none on a doc to convert', () => {
    expect(evidenceOnDoc(current, evidence).map(({ id }) => id)).toEqual(['early-returns']);
    expect(evidenceOnDoc({ _tag: 'Unconverted', text: '# Style' }, evidence)).toEqual([]);
  });
});

describe('a boundary card', () => {
  const nameValues: Principle = {
    id: 'name-intermediate-values',
    section: 'General',
    strength: 'moderate',
    statement: 'Bind a non-trivial sub-expression to a named const.',
    exception: {
      id: 'inline-single-use-calls',
      strength: 'tentative',
      statement: 'A value used once that is a single call stays inline.',
    },
  };
  const current = { _tag: 'Parsed', principles: [nameValues], isNormalised: true } as const;
  const card = (id: string, rule: Card['principle'], kind: Card['kind'], after: string): Card => ({
    id,
    operation: 'Inline Variable',
    change: 'Moves a value used once.',
    principle: rule,
    stance: 'opposes',
    kind,
    after,
  });
  const exception = { id: 'inline-single-use-calls', statement: nameValues.exception!.statement };
  const principle = { id: 'name-intermediate-values', statement: nameValues.statement };
  const roundOf = (cards: Card[]): Pick<Round, 'cards' | 'target'> => ({
    target: { file: 'src/f.ts', symbol: 'f', text: 'const total = sum(prices(cart));\nf(total)' },
    cards,
  });
  // Just inside the exception (one call), naming the value opposes it: two dislikes agree with it.
  const earlier = {
    id: 'EARLIER',
    round: roundOf([
      card('c1', exception, 'boundary', 'const items = list(cart, true);\nf(items)'),
    ]),
    swipes: [{ verdicts: { c1: 'dislike' } as const }, { verdicts: { c1: 'dislike' } as const }],
  };
  // Just outside it (two calls), inlining the value opposes the principle: two likes disagree.
  const now = roundOf([
    card('c1', principle, 'boundary', 'f(sum(prices(cart)))'),
    card('c2', exception, 'challenge', 'const size = count(cart);\nf(size)'),
  ]);
  const nowSwipes = [{ verdicts: { c1: 'like' } as const }, { verdicts: { c1: 'like' } as const }];
  const shown = evidenceOnDoc(
    current,
    principleEvidence({ principleIds: testedPrinciples(now), rounds: [earlier] }),
  );

  it('counts its swipes on the rule that governs its spot, for it when they agree with the doc', () => {
    expect(shown).toEqual([
      expect.objectContaining({
        id: 'inline-single-use-calls',
        for: 2,
        against: 0,
        confirming: expect.objectContaining({ ref: 'EARLIER/c1' }),
        contradicting: null,
      }),
    ]);
    const [outside] = tallyVerdicts(now, nowSwipes);
    expect(outside!.card.principle.id).toBe('name-intermediate-values');
    expect(evidenceOf({ stance: outside!.card.stance, ...outside! })).toEqual({
      for: 0,
      against: 2,
    });
  });

  it('lets learn widen the exception by its id, leaving its principle as it is', () => {
    const widened = 'A value used once that is one call or a call on a call stays inline.';
    const citations = citationsOf({ tallies: tallyVerdicts(now, nowSwipes), evidence: shown });
    expect([...citations.keys()]).toEqual(['c1', 'EARLIER/c1']);
    expect(
      apply(
        [nameValues],
        [{ op: 'reword', id: 'inline-single-use-calls', section: 'General', statement: widened }],
        citations,
      ),
    ).toEqual({
      principles: [{ ...nameValues, exception: { ...nameValues.exception!, statement: widened } }],
      skipped: [],
    });
  });
});

describe('applyLearnAnswer', () => {
  const answer = {
    operations: [{ op: 'strengthen', id: 'early-returns' }] as const,
    writtenRuleEdits: [],
  };

  it("applies the operations to the doc's principles", () => {
    const learned = applyLearnAnswer(
      { _tag: 'Parsed', principles: doc, isNormalised: true },
      answer,
      none,
    );
    expect(
      Result.map(learned, ({ principles }) => strengthOf(principles, 'early-returns')),
    ).toEqual(Result.succeed('strong'));
  });

  it('applies them to the converted principles of a doc out of format, and needs them', () => {
    const current = { _tag: 'Unconverted', text: '# Style' } as const;
    expect(Result.isFailure(applyLearnAnswer(current, answer, none))).toBe(true);
    const learned = applyLearnAnswer(current, { ...answer, converted: doc }, none);
    expect(Result.map(learned, ({ principles }) => principles.length)).toEqual(Result.succeed(3));
  });
});
