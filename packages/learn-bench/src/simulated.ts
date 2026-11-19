import { type Card, type Round, type Task, VerdictSchema } from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { cardsSection } from './cards';
import type { Dataset } from './dataset';
import { ask, MODELS } from './model';

/**
 * The simulated developer holds one rule with a scope, the kind a blanket principle gets wrong:
 * they name a value in one situation and inline it in another. Their other swipes are the real
 * developer's.
 */
const HIDDEN_RULE =
  'Bind a value to a named const when it is used more than once, or when its expression combines several operations; write a value that is used once and is a single call, property access or literal inline, where it is used.';

const OracleAnswerSchema = Schema.Struct({
  cards: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The card's id, as in its heading" }),
      isDecided: Schema.Boolean.annotate({
        description: 'Whether the change names or inlines a value, so the rule decides it',
      }),
      verdict: VerdictSchema.annotate({
        description:
          '"like" when the rule prefers the card\'s after, "dislike" when it prefers the original; either when the rule does not decide it',
      }),
    }),
  ).annotate({ description: 'One entry per card, in order' }),
});

const oracleTask = (round: Round, cards: readonly Card[]): Task<typeof OracleAnswerSchema> => ({
  instructions: `# Swipe as a developer who holds one rule

You hold exactly one coding rule:

> ${HIDDEN_RULE}

Each card below is a function with one change applied. For each card, say whether the change
names a value (binds it to a const) or inlines one, so that your rule decides it. If it does, say
which version the rule prefers: "like" for the card's after, "dislike" for the original.

${cardsSection(round, cards)}`,
  answerSchema: OracleAnswerSchema,
});

/** The verdicts the hidden rule decides, by round id, then card id. */
export const SimulatedVerdictsSchema = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, VerdictSchema),
);
export type SimulatedVerdicts = typeof SimulatedVerdictsSchema.Type;

export const SimulatedVerdictsJsonSchema = Schema.fromJsonString(SimulatedVerdictsSchema);

/** Asks the oracle once per round. Saved, so every learner is scored against the same swipes. */
export const simulateVerdicts = Effect.fn('simulated.simulateVerdicts')(function* (
  dataset: Dataset,
) {
  const entries = yield* Effect.forEach(
    dataset.rounds,
    ({ id, round }) =>
      ask(MODELS.judge, oracleTask(round, round.cards)).pipe(
        Effect.map(
          ({ cards }) =>
            [
              id,
              Object.fromEntries(
                cards.filter(({ isDecided }) => isDecided).map(({ id, verdict }) => [id, verdict]),
              ),
            ] as const,
        ),
      ),
    { concurrency: 4 },
  );
  return Object.fromEntries(entries) satisfies SimulatedVerdicts;
});
