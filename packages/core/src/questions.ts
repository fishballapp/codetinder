import * as Schema from 'effect/Schema';
import { PrincipleIdSchema, StatementSchema } from './principles';
import type { Round, Stance } from './round';
import { type CardTally, tallyVerdicts, type Verdicts } from './swipes';

const VotesSchema = Schema.Struct({ likes: Schema.Int, dislikes: Schema.Int });

/**
 * A principle a project's cards have tested, whether or not learn took it up, with every verdict
 * its cards got, counted by the cards' stance. Generate reads them to reuse ids and steer what it
 * asks next.
 */
export const QuestionSchema = Schema.Struct({
  id: PrincipleIdSchema,
  statement: StatementSchema,
  supports: VotesSchema,
  opposes: VotesSchema,
  roundsSinceJudged: Schema.NullOr(Schema.Int).annotate({
    description:
      'How many judged rounds ago a card on it last got a verdict: 0 for the newest judged round. null when none did within the rounds read',
  }),
});
export type Question = typeof QuestionSchema.Type;

const isJudged = ({ likes, dislikes }: CardTally) => likes + dislikes > 0;

/**
 * The questions of `rounds`, newest first, each with the statement of its newest card. A question
 * whose cards nobody swiped is still one: generate must not ask it under a new id.
 *
 * A round is judged when a card of it holds a verdict, and a question is judged in it when one of
 * its own cards does: a deck swiped in part rests only the questions it asked. The newest judged
 * round is age 0. Creation order stands in for the order of judgment.
 */
export const questionsOf = (
  rounds: readonly {
    readonly round: Pick<Round, 'cards'>;
    readonly swipes: readonly { readonly verdicts: Verdicts }[];
  }[],
): Question[] => {
  const talliesByRound = rounds.map(({ round, swipes }) => tallyVerdicts(round, swipes));
  const tallies = talliesByRound.flat();
  const judgedRounds = talliesByRound.filter(roundTallies => roundTallies.some(isJudged));
  const roundsSinceJudged = (id: string) => {
    const age = judgedRounds.findIndex(roundTallies =>
      roundTallies.some(tally => isJudged(tally) && tally.card.principle.id === id),
    );
    return age === -1 ? null : age;
  };
  const votes = (cardTallies: readonly CardTally[], stance: Stance) => {
    const withStance = cardTallies.filter(({ card }) => card.stance === stance);
    return {
      likes: sum(withStance.map(({ likes }) => likes)),
      dislikes: sum(withStance.map(({ dislikes }) => dislikes)),
    };
  };
  return [...Map.groupBy(tallies, ({ card }) => card.principle.id).values()].flatMap(
    cardTallies => {
      const [newest] = cardTallies;
      if (newest === undefined) return [];
      return [
        {
          ...newest.card.principle,
          supports: votes(cardTallies, 'supports'),
          opposes: votes(cardTallies, 'opposes'),
          roundsSinceJudged: roundsSinceJudged(newest.card.principle.id),
        },
      ];
    },
  );
};

const sum = (numbers: readonly number[]) => numbers.reduce((total, n) => total + n, 0);
