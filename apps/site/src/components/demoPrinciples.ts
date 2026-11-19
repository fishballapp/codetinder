import { type Card, evidence, type Principle, type Strength, type Verdict } from '@codetinder/core';
import { DEMO_ROUND } from './demoRound';

type Statement = Pick<Principle, 'id' | 'statement'>;

/**
 * What the doc says when the swipes go against a card's principle: the principle the other way
 * round. Learn words it from the swipes; the demo has it ready.
 */
const OPPOSITES: Readonly<Record<string, Statement>> = {
  'pipelines-over-loops': {
    id: 'plain-loops',
    statement: 'Count and collect with plain loops, not array pipelines.',
  },
  'descriptive-names': {
    id: 'short-names',
    statement: 'Keep names short in short scopes.',
  },
  'ternary-returns': {
    id: 'if-returns',
    statement: 'Spell a two-way return out with `if`, not a ternary.',
  },
  'function-declarations': {
    id: 'arrow-functions',
    statement: 'Declare named functions as arrow constants.',
  },
  'guard-clauses': {
    id: 'nested-conditions',
    statement: 'Nest the main path inside its condition rather than skipping ahead.',
  },
};

/** The round's principles, each once, in the order its cards first test them. */
const PRINCIPLES: readonly Statement[] = [
  ...new Map(DEMO_ROUND.cards.map(({ principle }) => [principle.id, principle])).values(),
];

/** How far the swipes so far lean on each principle: evidence for it, less evidence against. */
export type DemoScores = Readonly<Record<string, number>>;

export const NO_SCORES: DemoScores = {};

export const applyVerdict = (scores: DemoScores, card: Card, verdict: Verdict): DemoScores => {
  const { for: support, against } = evidence({
    stance: card.stance,
    likes: verdict === 'like' ? 1 : 0,
    dislikes: verdict === 'dislike' ? 1 : 0,
  });
  return {
    ...scores,
    [card.principle.id]: (scores[card.principle.id] ?? 0) + support - against,
  };
};

/** One agreeing swipe is a hunch; it firms up as more swipes agree. */
const strengthOf = (score: number): Strength => {
  if (score >= 4) return 'strong';
  if (score >= 2) return 'moderate';
  return 'tentative';
};

/** A principle as the swipes on it read: itself, or its opposite once they go against it. */
const sideOf = (principle: Statement, score: number): Statement => {
  if (score >= 0) return principle;
  const opposite = OPPOSITES[principle.id];
  if (opposite === undefined) throw new Error(`no opposite for ${principle.id}`);
  return opposite;
};

/**
 * The principles the swipes so far support, firmest first; one whose swipes cancel out says
 * nothing yet.
 */
export const demoPrinciples = (scores: DemoScores): Principle[] =>
  PRINCIPLES.flatMap(principle => {
    const score = scores[principle.id] ?? 0;
    if (score === 0) return [];
    return [
      {
        ...sideOf(principle, score),
        section: 'General' as const,
        strength: strengthOf(Math.abs(score)),
        score: Math.abs(score),
      },
    ];
  })
    .sort((a, b) => b.score - a.score)
    .map(({ score: _score, ...principle }) => principle);

/**
 * The doc's principle a swipe on `card` bears on, from the scores before and after it: as it reads
 * after the swipe, or, where the swipe cancelled it out, as it read before.
 */
export const principleSwayedBy = (before: DemoScores, after: DemoScores, card: Card): string => {
  const { id } = card.principle;
  return sideOf(card.principle, after[id] || before[id] || 0).id;
};
