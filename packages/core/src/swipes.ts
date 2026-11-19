import * as Schema from 'effect/Schema';
import type { Card, Round, Stance } from './round';

export const VerdictSchema = Schema.Literals(['like', 'dislike']);
export type Verdict = typeof VerdictSchema.Type;

/**
 * One developer's verdicts on one round, keyed by card id: a record, so a card has one verdict at
 * most. The round id lives in the URL / store key.
 */
export const VerdictsSchema = Schema.Record(Schema.NonEmptyString, VerdictSchema);
export type Verdicts = typeof VerdictsSchema.Type;

export type CardTally = { card: Card; likes: number; dislikes: number };

/** Each card of the round, in order, with the verdicts every developer gave it. */
export const tallyVerdicts = (
  round: Pick<Round, 'cards'>,
  swipes: readonly { readonly verdicts: Verdicts }[],
): CardTally[] =>
  round.cards.map(card => {
    const verdicts = swipes.map(({ verdicts }) => verdicts[card.id]);
    return {
      card,
      likes: verdicts.filter(verdict => verdict === 'like').length,
      dislikes: verdicts.filter(verdict => verdict === 'dislike').length,
    };
  });

/**
 * What a card's likes and dislikes say about its principle. A like prefers the after, so on a card
 * that opposes the principle it is evidence against it, and a dislike evidence for it.
 */
export const evidence = ({
  stance,
  likes,
  dislikes,
}: {
  stance: Stance;
  likes: number;
  dislikes: number;
}): { for: number; against: number } =>
  stance === 'supports' ? { for: likes, against: dislikes } : { for: dislikes, against: likes };
