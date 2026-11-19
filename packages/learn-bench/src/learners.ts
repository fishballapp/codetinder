import {
  applyLearnAnswer,
  type CardTally,
  type CurrentPrinciples,
  citationsOf,
  evidenceOnDoc,
  learnTask,
  type Principle,
  type PrincipleEvidence,
  type Round,
} from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { ask, MODELS, type Model, ModelAnswerInvalid } from './model';

type Learn = (input: {
  readonly principles: readonly Principle[];
  readonly round: Round;
  readonly tallies: readonly CardTally[];
  readonly evidence: readonly PrincipleEvidence[];
}) => Effect.Effect<readonly Principle[], ModelAnswerInvalid, Model>;

/**
 * A control that adds an exception wherever a card disagrees, with no bar on the evidence: the
 * pile-up of exceptions a refining learn must not show.
 */
const REFINE_FREELY = `
- When a card contradicts a principle that other cards confirm, don't weaken it: reword its
  statement instead, naming the situation the card shows where it doesn't hold
  ("…, except when …").`;

/** The flow's own learn task, as this checkout of core writes it. */
const learnWith =
  (extraRules: string): Learn =>
  ({ principles, round, tallies, evidence }) => {
    const current: CurrentPrinciples = { _tag: 'Parsed', principles, isNormalised: true };
    const task = learnTask({ current, writtenRules: [], round, tallies, evidence });
    return ask(MODELS.learn, { ...task, instructions: `${task.instructions}${extraRules}` }).pipe(
      Effect.flatMap(answer =>
        Result.match(
          applyLearnAnswer(
            current,
            answer,
            citationsOf({ tallies, evidence: evidenceOnDoc(current, evidence) }),
          ),
          {
            onSuccess: ({ principles }) => Effect.succeed(principles),
            onFailure: message => Effect.fail(new ModelAnswerInvalid({ message })),
          },
        ),
      ),
    );
  };

export const LearnerSchema = Schema.Literals(['current', 'refine-freely']);
export type Learner = typeof LearnerSchema.Type;

export const LEARNERS: Record<Learner, { readonly description: string; readonly learn: Learn }> = {
  current: { description: "core's learn task, as this checkout has it", learn: learnWith('') },
  'refine-freely': {
    description: 'the learn task told to add an exception on any disagreeing card',
    learn: learnWith(REFINE_FREELY),
  },
};
