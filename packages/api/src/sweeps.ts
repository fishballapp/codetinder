import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as Schema from 'effect/Schema';
import { Forbidden, Unauthorized } from './authentication';
import { CommitShaSchema, RunIdSchema } from './claims';
import { NotClaimOwner } from './rounds';

/** What a project sweeps at until its developer picks another number. */
export const DEFAULT_SWEEP_THRESHOLD = 5_000;

/**
 * Lines of code added since the last sweep that start the next one. At least 100, far above what
 * one sweep rewrites, so a sweep's own MR can't start the next.
 */
export const SweepThresholdSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(100));

/** A function a sweep found breaking a principle and left for the next sweep, past its limit. */
export const SweepFunctionSchema = Schema.Struct({
  file: Schema.String,
  name: Schema.String,
});
export type SweepFunction = typeof SweepFunctionSchema.Type;

/** How a sweep ended: its MR opened, or the changed code already followed the principles. */
export const SweepOutcomeSchema = Schema.TaggedUnion({
  Proposed: { mergeRequestIid: Schema.Int },
  Clean: {},
});
export type SweepOutcome = typeof SweepOutcomeSchema.Type;

/** The last sweep that finished: the window the next one counts its lines from starts at it. */
export const LastSweepSchema = Schema.Struct({
  /** The commit it swept up to: the next sweep counts the lines added since. */
  sha: CommitShaSchema,
  at: Schema.DateTimeUtc,
  outcome: SweepOutcomeSchema,
});
export type LastSweep = typeof LastSweepSchema.Type;

/**
 * Why a sweep stopped short: its agent's answer couldn't be used, even corrected; its rewrite
 * failed the tests, even retried; the project's install or tests fail in the sandbox before any
 * change; GitLab refused its MR; or anything else went wrong.
 */
export const SweepStopCauseSchema = Schema.Literals([
  'Answer',
  'Tests',
  'Sandbox',
  'GitLab',
  'Error',
]);
export type SweepStopCause = typeof SweepStopCauseSchema.Type;

/**
 * A sweep that stopped short since the last one finished. It swept nothing, so it has no commit:
 * the next sweep still counts from the last finished one's.
 */
export const StoppedSweepSchema = Schema.Struct({
  at: Schema.DateTimeUtc,
  cause: SweepStopCauseSchema,
});
export type StoppedSweep = typeof StoppedSweepSchema.Type;

/** A project's sweep, as its flow and its developers read it. */
export const SweepStateSchema = Schema.Struct({
  threshold: SweepThresholdSchema,
  /** None until a sweep has finished; the first takes the latest `threshold` lines of code changed. */
  last: Schema.NullOr(LastSweepSchema),
  /** The latest sweep, when it stopped short after `last`; none once a sweep finishes. */
  stopped: Schema.NullOr(StoppedSweepSchema),
  carryOver: Schema.Array(SweepFunctionSchema),
  /** Whether a run holds the sweep's claim now. */
  isRunning: Schema.Boolean,
});
export type SweepState = typeof SweepStateSchema.Type;

export const PutSweepThresholdPayloadSchema = Schema.Struct({
  threshold: SweepThresholdSchema,
});
export type PutSweepThresholdPayload = typeof PutSweepThresholdPayloadSchema.Type;

/** A run asking to sweep its project at the commit it checked out. */
export const SweepClaimPayloadSchema = Schema.Struct({
  headSha: CommitShaSchema,
  runId: RunIdSchema,
});
export type SweepClaimPayload = typeof SweepClaimPayloadSchema.Type;

/** `Claimed`, the run sweeps (also to the owner asking again); `Busy`, another run is sweeping. */
export const SweepClaimSuccessSchema = Schema.TaggedUnion({
  Claimed: {},
  Busy: {},
});
export type SweepClaimSuccess = typeof SweepClaimSuccessSchema.Type;

/**
 * The owner's sweep done: the commit it swept becomes the last sweep's, and the functions it left
 * replace the carry-over.
 */
export const FinishSweepPayloadSchema = Schema.Struct({
  runId: RunIdSchema,
  headSha: CommitShaSchema,
  outcome: SweepOutcomeSchema,
  carryOver: Schema.Array(SweepFunctionSchema),
});
export type FinishSweepPayload = typeof FinishSweepPayloadSchema.Type;

/** The owner gives its claim up: no sweep was due, the last sweep unchanged. */
export const EndSweepPayloadSchema = Schema.Struct({
  runId: RunIdSchema,
});
export type EndSweepPayload = typeof EndSweepPayloadSchema.Type;

/**
 * The owner's sweep stopped short: it is recorded as stopped and the claim given up, the last
 * sweep and the carry-over unchanged.
 */
export const StopSweepPayloadSchema = Schema.Struct({
  runId: RunIdSchema,
  cause: SweepStopCauseSchema,
});
export type StopSweepPayload = typeof StopSweepPayloadSchema.Type;

const projectIdParams = { projectId: Schema.String.check(Schema.isPattern(/^\d+$/)) };

/**
 * One sweep per project at a time. Its flow reads, claims, finishes, stops and ends it; a
 * developer who can read the project reads it, and one who can push to it sets the threshold.
 */
export class SweepsApi extends HttpApiGroup.make('sweeps')
  .add(
    HttpApiEndpoint.get('get', '/:projectId', {
      params: projectIdParams,
      success: SweepStateSchema,
      error: [Unauthorized, Forbidden],
    }),
    HttpApiEndpoint.put('putThreshold', '/:projectId/threshold', {
      params: projectIdParams,
      payload: PutSweepThresholdPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden],
    }),
    HttpApiEndpoint.post('claim', '/:projectId/claim', {
      params: projectIdParams,
      payload: SweepClaimPayloadSchema,
      success: SweepClaimSuccessSchema,
      error: [Unauthorized, Forbidden],
    }),
    HttpApiEndpoint.post('finish', '/:projectId/finish', {
      params: projectIdParams,
      payload: FinishSweepPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden, NotClaimOwner],
    }),
    HttpApiEndpoint.post('stop', '/:projectId/stop', {
      params: projectIdParams,
      payload: StopSweepPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden],
    }),
    HttpApiEndpoint.post('end', '/:projectId/end', {
      params: projectIdParams,
      payload: EndSweepPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden],
    }),
  )
  .prefix('/api/sweeps') {}
