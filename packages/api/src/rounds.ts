import { PrincipleEvidenceSchema, RoundSchema, VerdictsSchema } from '@codetinder/core';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as Schema from 'effect/Schema';
import { Forbidden, Unauthorized } from './authentication';
import { CommitShaSchema, RunIdSchema } from './claims';
import {
  AskNotePayloadSchema,
  AskSuccessSchema,
  LearnReportPayloadSchema,
  LearnStateSchema,
  RetryLearnPayloadSchema,
} from './learn';
import { RoundIdSchema } from './round-id';

export class RoundNotFound extends Schema.TaggedError<RoundNotFound>()(
  'RoundNotFound',
  { message: Schema.String },
  { httpApiStatus: 404 },
) {}

export class RoundTooLarge extends Schema.TaggedError<RoundTooLarge>()(
  'RoundTooLarge',
  { message: Schema.String },
  { httpApiStatus: 413 },
) {}

/** Verdicts that name a card the round doesn't have. */
export class InvalidSwipes extends Schema.TaggedError<InvalidSwipes>()(
  'InvalidSwipes',
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

/** A Done for swipes a finished learn run covered: there is nothing new to learn. */
export class AlreadyLearned extends Schema.TaggedError<AlreadyLearned>()(
  'AlreadyLearned',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A Done for swipes a learn run is still learning. */
export class AlreadyLearning extends Schema.TaggedError<AlreadyLearning>()(
  'AlreadyLearning',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * Asking again for an ask that isn't the round's latest, has started, isn't past its wait, or was
 * itself asked again: another page asked first, or GitLab picked it up after all.
 */
export class RetryNotDue extends Schema.TaggedError<RetryNotDue>()(
  'RetryNotDue',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

/** A round for a commit whose claim the run doesn't hold: another run's, or none. */
export class NotClaimOwner extends Schema.TaggedError<NotClaimOwner>()(
  'NotClaimOwner',
  { message: Schema.String },
  { httpApiStatus: 409 },
) {}

export const CreateRoundPayloadSchema = Schema.Struct({
  mergeRequestIid: Schema.Int,
  /** The commit the round was made at, which the run claimed. */
  headSha: CommitShaSchema,
  /** The run that claimed it: only its round is stored, once however often it asks. */
  runId: RunIdSchema,
  round: RoundSchema,
});
export type CreateRoundPayload = typeof CreateRoundPayloadSchema.Type;

export const CreateRoundSuccessSchema = Schema.Struct({
  id: RoundIdSchema,
});
export type CreateRoundSuccess = typeof CreateRoundSuccessSchema.Type;

export const GetRoundSuccessSchema = Schema.Struct({
  id: RoundIdSchema,
  projectId: Schema.String,
  mergeRequestIid: Schema.Int,
  round: RoundSchema,
  createdAt: Schema.DateTimeUtc,
});
export type GetRoundSuccess = typeof GetRoundSuccessSchema.Type;

export const PutSwipesPayloadSchema = Schema.Struct({
  verdicts: VerdictsSchema,
});
export type PutSwipesPayload = typeof PutSwipesPayloadSchema.Type;

export const DeveloperSwipesSchema = Schema.Struct({
  userId: Schema.Int,
  username: Schema.String,
  verdicts: VerdictsSchema,
  updatedAt: Schema.DateTimeUtc,
});
export type DeveloperSwipes = typeof DeveloperSwipesSchema.Type;

export const GetSwipesSuccessSchema = Schema.Struct({
  swipes: Schema.Array(DeveloperSwipesSchema),
});
export type GetSwipesSuccess = typeof GetSwipesSuccessSchema.Type;

/** How many of a project's rounds before a round its evidence is worked out from. */
export const EVIDENCE_ROUNDS = 50;

export const GetEvidenceSuccessSchema = Schema.Struct({
  evidence: Schema.Array(PrincipleEvidenceSchema),
});
export type GetEvidenceSuccess = typeof GetEvidenceSuccessSchema.Type;

const roundIdParams = { id: RoundIdSchema };

export class RoundsApi extends HttpApiGroup.make('rounds')
  .add(
    HttpApiEndpoint.post('create', '/', {
      payload: CreateRoundPayloadSchema,
      success: CreateRoundSuccessSchema,
      error: [Unauthorized, Forbidden, RoundTooLarge, NotClaimOwner],
    }),
    HttpApiEndpoint.get('getById', '/:id', {
      params: roundIdParams,
      success: GetRoundSuccessSchema,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.put('putSwipes', '/:id/swipes', {
      params: roundIdParams,
      payload: PutSwipesPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden, RoundNotFound, InvalidSwipes],
    }),
    HttpApiEndpoint.get('getSwipes', '/:id/swipes', {
      params: roundIdParams,
      success: GetSwipesSuccessSchema,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.get('getEvidence', '/:id/evidence', {
      params: roundIdParams,
      success: GetEvidenceSuccessSchema,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.get('getMySwipes', '/:id/swipes/mine', {
      params: roundIdParams,
      success: VerdictsSchema,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.get('getLearn', '/:id/learn', {
      params: roundIdParams,
      success: LearnStateSchema,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.post('recordDone', '/:id/done', {
      params: roundIdParams,
      success: AskSuccessSchema,
      error: [Unauthorized, Forbidden, RoundNotFound, AlreadyLearned, AlreadyLearning],
    }),
    HttpApiEndpoint.post('retryLearn', '/:id/done/retry', {
      params: roundIdParams,
      payload: RetryLearnPayloadSchema,
      success: AskSuccessSchema,
      error: [Unauthorized, Forbidden, RoundNotFound, RetryNotDue],
    }),
    HttpApiEndpoint.put('putAskNote', '/:id/done/note', {
      params: roundIdParams,
      payload: AskNotePayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
    HttpApiEndpoint.post('reportLearn', '/:id/learn', {
      params: roundIdParams,
      payload: LearnReportPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden, RoundNotFound],
    }),
  )
  .prefix('/api/rounds') {}
