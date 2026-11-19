import type { Question } from './questions';
import { MIN_ROUND_CARDS } from './round';

/**
 * A question judged within this many of the project's latest judged rounds rests: its age is 0 to
 * one less, and a round asks little of it.
 */
export const REST_ROUNDS = 3;

/**
 * The questions generate read when it wrote its task, kept outside the repo so the agent can't
 * reach them: the checks of its answer, and of its correction, are made against these.
 */
export const QUESTIONS_SNAPSHOT_FILE = '/tmp/codetinder/questions.json';

type AgedQuestion = Pick<Question, 'id' | 'roundsSinceJudged'>;

export const isResting = (age: number | null): age is number => age !== null && age < REST_ROUNDS;

export const describeAge = (age: number | null): string =>
  age === null ? 'not judged lately' : `age ${age}`;

/**
 * A question's age; null for one not judged lately and for an id no earlier card used, which are
 * both eligible.
 */
const ageOf = (questions: readonly AgedQuestion[], id: string): number | null =>
  questions.find(({ id: questionId }) => questionId === id)?.roundsSinceJudged ?? null;

type CardOnQuestion = { readonly principle: { readonly id: string } };

/**
 * Cards on resting questions are kept in step with the others: at least half of a round's cards
 * must be eligible, which is to say at most as many may rest as are eligible. The excess are
 * removed, the most recently judged question's first and, among equals, the card nearest the end
 * of the deck, and the rest keep their order. A consistency pair is two cards: each is a swipe
 * the developer makes.
 */
export const withinFreshnessBudget = <Card extends CardOnQuestion>(
  cards: readonly Card[],
  questions: readonly AgedQuestion[],
): { readonly kept: Card[]; readonly removed: Card[] } => {
  const resting = cards.flatMap((card, position) => {
    const age = ageOf(questions, card.principle.id);
    return isResting(age) ? [{ card, age, position }] : [];
  });
  const excess = resting.length - (cards.length - resting.length);
  const removed = resting
    .toSorted((left, right) => left.age - right.age || right.position - left.position)
    .slice(0, Math.max(excess, 0))
    .map(({ card }) => card);
  const removedCards = new Set(removed);
  return { kept: cards.filter(card => !removedCards.has(card)), removed };
};

export const countEligible = (
  cards: readonly CardOnQuestion[],
  questions: readonly AgedQuestion[],
) => cards.filter(({ principle }) => !isResting(ageOf(questions, principle.id))).length;

/**
 * What the agent needs to fix a round the freshness budget left too short: each card's question
 * and age, which ids were removed, which are new, and how many cards remain.
 */
export const freshnessShortfall = ({
  cards,
  kept,
  questions,
}: {
  readonly cards: readonly (CardOnQuestion & { readonly operation: string })[];
  readonly kept: readonly CardOnQuestion[];
  readonly questions: readonly AgedQuestion[];
}): string => {
  const keptCards = new Set(kept);
  const isKnown = (id: string) => questions.some(({ id: questionId }) => questionId === id);
  const removedIds = new Set(
    cards.filter(card => !keptCards.has(card)).map(({ principle }) => principle.id),
  );
  const mintedIds = new Set(cards.map(({ principle }) => principle.id).filter(id => !isKnown(id)));
  const listed = (ids: ReadonlySet<string>) => (ids.size === 0 ? 'none' : [...ids].join(', '));
  const lines = cards.map(card => {
    const { operation, principle } = card;
    const age = ageOf(questions, principle.id);
    const standing = (() => {
      if (!isKnown(principle.id)) return 'a new id';
      return `${describeAge(age)}, ${isResting(age) ? 'resting' : 'eligible'}`;
    })();
    const removal = keptCards.has(card) ? '' : ', removed';
    return `- ${operation}: ${principle.id}, ${standing}${removal}`;
  });
  return `Only ${kept.length} of your cards remain after the freshness check, and a round needs ${MIN_ROUND_CARDS}.

A question judged in one of the project's last ${REST_ROUNDS} judged rounds (age 0 to ${REST_ROUNDS - 1}) is resting. A round keeps at most as many cards on resting questions as on the rest, and drops the most recently judged first. Your cards:

${lines.join('\n')}

Removed ids: ${listed(removedIds)}
New ids: ${listed(mintedIds)}
Cards remaining: ${kept.length}

Pick another changed function whose changes can ask questions that are not resting, and answer for it. Don't relabel a resting idea under a new id: a card on the same idea counts as resting.`;
};
