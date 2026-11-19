import * as Schema from 'effect/Schema';
import { unifiedDiff } from './diff';
import { PrincipleIdSchema } from './principles';
import type { Round } from './round';
import { type CardTally, evidence, tallyVerdicts, type Verdicts } from './swipes';

/** Unchanged lines a card's diff shows either side of its change, as learn shows every card. */
export const DIFF_CONTEXT_LINES = 3;

/** A card of an earlier round, as learn reads it: its change and the verdicts it got. */
export const EarlierCardSchema = Schema.Struct({
  /** `<round id>/<card id>`: how learn cites it. */
  ref: Schema.String,
  file: Schema.String,
  /** The card's change, named as the round page names it. */
  operation: Schema.String,
  change: Schema.String,
  /** The card against its round's original, as a unified diff. */
  diff: Schema.String,
  likes: Schema.Int,
  dislikes: Schema.Int,
});
export type EarlierCard = typeof EarlierCardSchema.Type;

/**
 * What earlier rounds' swipes say about one principle: every verdict its cards got, counted for and
 * against it, and the newest card that confirmed it and the newest that contradicted it.
 */
export const PrincipleEvidenceSchema = Schema.Struct({
  id: PrincipleIdSchema,
  for: Schema.Int,
  against: Schema.Int,
  confirming: Schema.NullOr(EarlierCardSchema),
  contradicting: Schema.NullOr(EarlierCardSchema),
});
export type PrincipleEvidence = typeof PrincipleEvidenceSchema.Type;

/** The ids a round's cards test: the principles whose evidence its learn is shown. */
export const testedPrinciples = (round: Pick<Round, 'cards'>): ReadonlySet<string> =>
  new Set(round.cards.map(({ principle }) => principle.id));

const sum = (numbers: readonly number[]) => numbers.reduce((total, number) => total + number, 0);

/**
 * The evidence on each of `principleIds` from `rounds`, the rounds before the one being learned,
 * newest first. A principle no earlier verdict bears on has none.
 */
export const principleEvidence = ({
  principleIds,
  rounds,
}: {
  readonly principleIds: ReadonlySet<string>;
  readonly rounds: readonly {
    readonly id: string;
    readonly round: Pick<Round, 'cards' | 'target'>;
    readonly swipes: readonly { readonly verdicts: Verdicts }[];
  }[];
}): PrincipleEvidence[] => {
  const judged = rounds.flatMap(({ id, round, swipes }) =>
    tallyVerdicts(round, swipes)
      .filter(({ likes, dislikes }) => likes + dislikes > 0)
      .map(tally => ({
        roundId: id,
        round,
        tally,
        votes: evidence({
          stance: tally.card.stance,
          likes: tally.likes,
          dislikes: tally.dislikes,
        }),
      })),
  );
  const earlierCard = ({
    roundId,
    round,
    tally: { card, likes, dislikes },
  }: {
    readonly roundId: string;
    readonly round: Pick<Round, 'target'>;
    readonly tally: CardTally;
  }): EarlierCard => ({
    ref: `${roundId}/${card.id}`,
    file: round.target.file,
    operation: card.operation,
    change: card.change,
    diff: unifiedDiff(round.target.text, card.after, { context: DIFF_CONTEXT_LINES }),
    likes,
    dislikes,
  });
  return [...principleIds].flatMap(id => {
    const cards = judged.filter(({ tally }) => tally.card.principle.id === id);
    if (cards.length === 0) return [];
    const confirming = cards.find(({ votes }) => votes.for > votes.against);
    const contradicting = cards.find(({ votes }) => votes.against > votes.for);
    return [
      {
        id,
        for: sum(cards.map(({ votes }) => votes.for)),
        against: sum(cards.map(({ votes }) => votes.against)),
        confirming: confirming === undefined ? null : earlierCard(confirming),
        contradicting: contradicting === undefined ? null : earlierCard(contradicting),
      },
    ];
  });
};
