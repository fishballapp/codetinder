import { Api, type ClaimSuccess, CurrentCaller, Forbidden, type RoundId } from '@codetinder/api';
import { type RoundEvent, runTimeout } from '@codetinder/core';
import * as Clock from 'effect/Clock';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Option from 'effect/Option';
import { type Claim, type CommitKey, RoundStore } from './round-store';

/**
 * How long a claim with no round and no ending holds before another run may take the commit: a
 * generate run whose agent corrects its answer, from `route` to the last `round` (81 minutes). A
 * slower run that loses its claim has its upload refused (`NotClaimOwner`).
 */
const CLAIM_TIMEOUT = runTimeout({ commands: 3, agents: 2, testSteps: 2 });

/** A developer's ask for a new round: a reviewer's request, or a `round` mention. */
const isAsk = (event: RoundEvent): boolean => event === 'assign_reviewer' || event === 'mention';

/**
 * What a run asking for a commit gets, given the claim already on it. The run holding it, asking
 * again (its client retrying an answer it lost), is answered as the first time, whatever came of
 * it. The claim records the latest ask its round answers, and only a developer's ask by a newer
 * note makes a new round on a commit that has one, or retries one a run gave up on (a skip, a
 * failure). Every session of one ask names the same note, so a duplicate is answered as the
 * claim stands, and so is an automatic event, a duplicate of the one that tried.
 */
export const claimDecision = ({
  claim,
  runId,
  event,
  askNoteId,
  nowMs,
}: {
  readonly claim: Claim;
  readonly runId: string;
  readonly event: RoundEvent;
  readonly askNoteId: Option.Option<number>;
  readonly nowMs: number;
}): ClaimSuccess | Retake => {
  if (claim.runId === runId) return { _tag: 'Claimed' };
  // GitLab's note ids only grow: a later ask's note is newer, a delayed session's never is.
  const answeredNoteId = Option.getOrElse(claim.askNoteId, () => Number.NEGATIVE_INFINITY);
  const isNewerNote = Option.exists(askNoteId, noteId => noteId > answeredNoteId);
  const isNewAsk = isAsk(event) && isNewerNote;
  const isSettled = Option.isSome(claim.roundId) || Option.isSome(claim.endedAt);
  if (isNewAsk && isSettled) return { _tag: 'Retake', replacedRoundId: claim.roundId };
  if (Option.isSome(claim.roundId)) return { _tag: 'HasRound', roundId: claim.roundId.value };
  if (Option.isSome(claim.endedAt)) return { _tag: 'Tried' };
  const heldMs = nowMs - DateTime.toEpochMillis(claim.claimedAt);
  return heldMs >= Duration.toMillis(CLAIM_TIMEOUT)
    ? { _tag: 'Retake', replacedRoundId: Option.none() }
    : { _tag: 'Busy' };
};

/** The commit goes to the asking run, replacing the claim's round when it had one. */
type Retake = {
  readonly _tag: 'Retake';
  readonly replacedRoundId: Option.Option<RoundId>;
};

export const ClaimsApiLive = HttpApiBuilder.group(
  Api,
  'claims',
  Effect.fn('ClaimsApiLive')(function* (handlers) {
    const store = yield* RoundStore;

    /** The flow's project: a claim is only ever on a commit of the caller's own project. */
    const flowProjectId = Effect.fn('ClaimsApi.flowProjectId')(function* () {
      const caller = yield* CurrentCaller;
      if (caller._tag !== 'Flow') {
        return yield* new Forbidden({ message: 'only a flow may claim a commit' });
      }
      return caller.projectId;
    });

    /** After losing a race to write the claim: Claimed if the winner was this run, else Busy. */
    const afterLostWrite = Effect.fn('ClaimsApi.afterLostWrite')(function* (
      key: CommitKey,
      runId: string,
    ) {
      const claim = yield* store.getClaim(key);
      const isOwn = Option.exists(
        claim,
        held => held.runId === runId && Option.isNone(held.endedAt) && Option.isNone(held.roundId),
      );
      return isOwn ? ({ _tag: 'Claimed' } as const) : ({ _tag: 'Busy' } as const);
    });

    return handlers.handleAll({
      claim: Effect.fn('ClaimsApi.claim')(function* ({ payload }) {
        const key = {
          projectId: yield* flowProjectId(),
          mergeRequestIid: payload.mergeRequestIid,
          headSha: payload.headSha,
        };
        const nowMs = yield* Clock.currentTimeMillis;
        const askNoteId = Option.fromUndefinedOr(payload.askNoteId);
        const claim = {
          key,
          runId: payload.runId,
          claimedAt: DateTime.makeUnsafe(nowMs),
          askNoteId,
        };

        const held = yield* store.getClaim(key);
        if (Option.isNone(held)) {
          if (yield* store.createClaim(claim)) return { _tag: 'Claimed' } as const;
          return yield* afterLostWrite(key, payload.runId);
        }
        const decision = claimDecision({
          claim: held.value,
          runId: payload.runId,
          event: payload.event,
          askNoteId,
          nowMs,
        });
        if (decision._tag !== 'Retake') return decision;
        const isRetaken = yield* store.retakeClaim({
          ...claim,
          expectedRevision: held.value.revision,
        });
        if (!isRetaken) return yield* afterLostWrite(key, payload.runId);
        const { replacedRoundId } = decision;
        return {
          _tag: 'Claimed',
          ...(Option.isSome(replacedRoundId) ? { replacedRoundId: replacedRoundId.value } : {}),
        } as const;
      }),

      // Only the holder's end of a claim still running applies; any other is a no-op, so a stale
      // retry can never release a claim another run has since taken.
      end: Effect.fn('ClaimsApi.end')(function* ({ payload }) {
        const key = {
          projectId: yield* flowProjectId(),
          mergeRequestIid: payload.mergeRequestIid,
          headSha: payload.headSha,
        };
        const held = yield* store.getClaim(key);
        if (Option.isNone(held)) return;
        const { runId, endedAt, roundId, revision } = held.value;
        if (runId !== payload.runId || Option.isSome(endedAt) || Option.isSome(roundId)) return;
        yield* store.endClaim({
          key,
          endedAt: DateTime.makeUnsafe(yield* Clock.currentTimeMillis),
          expectedRevision: revision,
        });
      }),
    });
  }),
);
