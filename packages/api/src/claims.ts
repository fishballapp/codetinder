import { RoundEventSchema } from '@codetinder/core';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema';
import * as Schema from 'effect/Schema';
import * as Struct from 'effect/Struct';
import { Forbidden, Unauthorized } from './authentication';
import { RoundIdSchema } from './round-id';

/** A git commit's id, SHA-1 or SHA-256, in lowercase hex. */
export const CommitShaSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
);

/**
 * One run of the flow, named by the run itself (a random UUID), so a claim knows its owner: the
 * owner's repeated requests (a client retry after a lost answer) are answered as the first was,
 * anyone else's refused.
 */
export const RunIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
);
export type RunId = typeof RunIdSchema.Type;

/** A run asking to make the round for one commit of an MR of its project. */
export const ClaimPayloadSchema = Schema.Struct({
  mergeRequestIid: Schema.Int,
  headSha: CommitShaSchema,
  runId: RunIdSchema,
  /**
   * What started the run: only a developer's ask, a reviewer's request or a `round` mention, makes
   * a new round on a commit that has one, or retries one an earlier run gave up on.
   */
  event: RoundEventSchema,
  /**
   * The note of the latest ask the run's round answers, the same for every session of one ask: a
   * mention's own note, else the system note of the MR's latest request for CodeTinder's review.
   */
  askNoteId: Schema.optionalKey(Schema.Int),
});
export type ClaimPayload = typeof ClaimPayloadSchema.Type;

/** The commit a run claimed, whose attempt ended without a round. Only the owner's end applies. */
export const EndClaimPayloadSchema = ClaimPayloadSchema.mapFields(
  Struct.pick(['mergeRequestIid', 'headSha', 'runId']),
);
export type EndClaimPayload = typeof EndClaimPayloadSchema.Type;

/**
 * The server's answer: `Claimed`, the run makes the round (also to the owner asking again), with
 * the round it replaces when the commit had one; `Busy`, another run is making it; `Tried`, an
 * earlier run ended without a round; `HasRound`, the commit has its round.
 */
export const ClaimSuccessSchema = Schema.TaggedUnion({
  Claimed: { replacedRoundId: Schema.optionalKey(RoundIdSchema) },
  Busy: {},
  Tried: {},
  HasRound: { roundId: RoundIdSchema },
});
export type ClaimSuccess = typeof ClaimSuccessSchema.Type;

/** One round per commit, decided on the server so that runs racing on one commit agree. */
export class ClaimsApi extends HttpApiGroup.make('claims')
  .add(
    HttpApiEndpoint.post('claim', '/', {
      payload: ClaimPayloadSchema,
      success: ClaimSuccessSchema,
      error: [Unauthorized, Forbidden],
    }),
    HttpApiEndpoint.post('end', '/end', {
      payload: EndClaimPayloadSchema,
      success: HttpApiSchema.NoContent,
      error: [Unauthorized, Forbidden],
    }),
  )
  .prefix('/api/claims') {}
