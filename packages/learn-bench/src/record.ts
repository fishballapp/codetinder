import { PrincipleSchema, VerdictSchema } from '@codetinder/core';
import * as Schema from 'effect/Schema';
import { PredictionSchema } from './judge';

/** Whose swipes the replay learns from and scores against. */
export const DeveloperSchema = Schema.Literals(['real', 'simulated']);
export type Developer = typeof DeveloperSchema.Type;

/** One card the judge predicted, against the swipe it got. */
export const JudgedCardSchema = Schema.Struct({
  cardId: Schema.String,
  truth: VerdictSchema,
  prediction: PredictionSchema,
  principleId: Schema.NullOr(Schema.String),
  /** On a simulated developer: the card is one their hidden rule decides. */
  isRuleCard: Schema.Boolean,
});
export type JudgedCard = typeof JudgedCardSchema.Type;

/**
 * One round of the replay: its cards judged from the doc learned before it, then the doc learn
 * made from it.
 */
export const StepSchema = Schema.Struct({
  roundId: Schema.String,
  judged: Schema.Array(JudgedCardSchema),
  principles: Schema.Array(PrincipleSchema),
  /** Learn gave no valid answer, so the doc stayed as it was. */
  isLearnFailed: Schema.Boolean,
});
export type Step = typeof StepSchema.Type;

/** One replay of a project's rounds through one learner. */
export const RunRecordSchema = Schema.Struct({
  label: Schema.String,
  learner: Schema.String,
  developer: DeveloperSchema,
  /** The share of swipes learn saw flipped. */
  noise: Schema.Finite,
  seed: Schema.Int,
  startedAt: Schema.String,
  steps: Schema.Array(StepSchema),
});
export type RunRecord = typeof RunRecordSchema.Type;

export const RunRecordJsonSchema = Schema.fromJsonString(RunRecordSchema);
