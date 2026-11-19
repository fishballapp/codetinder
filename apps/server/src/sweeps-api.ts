import {
  Api,
  CurrentCaller,
  DEFAULT_SWEEP_THRESHOLD,
  type EndSweepPayload,
  type FinishSweepPayload,
  Forbidden,
  NotClaimOwner,
  type StopSweepPayload,
  type SweepClaimPayload,
  type SweepClaimSuccess,
  type SweepState,
} from '@codetinder/api';
import { runTimeout } from '@codetinder/core';
import * as Clock from 'effect/Clock';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Option from 'effect/Option';
import { CachedGitLabUsers } from './authentication';
import { type StoredSweep, type SweepClaim, type SweepRecord, SweepStore } from './sweep-store';

/** What a project with no sweep yet reads as. */
const defaultSweep: SweepRecord = {
  threshold: DEFAULT_SWEEP_THRESHOLD,
  last: null,
  stopped: null,
  carryOver: [],
  claim: null,
};

/** What a decision leaves: its answer, and the sweep to write, or none when nothing changes. */
type Decision<A> = { readonly result: A; readonly next: SweepRecord | null };

/**
 * How long a sweep's claim holds before a new run may take the sweep over: a sweep whose answer is
 * corrected and whose rewrite is retried, from `route` to `sweep propose` (101 minutes). A slower
 * run that loses its claim publishes nothing: `sweep propose` asks for the claim again first, and
 * `finish` refuses it.
 */
const SWEEP_CLAIM_TIMEOUT = runTimeout({ commands: 8, agents: 4, testSteps: 2 });

const isExpired = (claim: SweepClaim, nowMs: number): boolean =>
  nowMs - DateTime.toEpochMillis(claim.claimedAt) >= Duration.toMillis(SWEEP_CLAIM_TIMEOUT);

/** The sweep as its flow and developers read it: a claim held past the timeout is no longer running. */
export const sweepState = (sweep: SweepRecord, nowMs: number): SweepState => ({
  threshold: sweep.threshold,
  last:
    sweep.last === null
      ? null
      : { sha: sweep.last.sha, at: sweep.last.at, outcome: sweep.last.outcome },
  stopped: sweep.stopped,
  carryOver: sweep.carryOver,
  isRunning: sweep.claim !== null && !isExpired(sweep.claim, nowMs),
});

/**
 * Who sweeps: the run holding the sweep, or a run asking again (its client retrying an answer it
 * lost). A claim held past the timeout belonged to a crashed run, so the new one takes it.
 */
export const claimSweep = ({
  sweep,
  payload,
  nowMs,
}: {
  readonly sweep: SweepRecord;
  readonly payload: SweepClaimPayload;
  readonly nowMs: number;
}): Decision<SweepClaimSuccess> => {
  const { claim } = sweep;
  if (claim === null || isExpired(claim, nowMs)) {
    const taken: SweepClaim = {
      runId: payload.runId,
      headSha: payload.headSha,
      claimedAt: DateTime.makeUnsafe(nowMs),
    };
    return { result: { _tag: 'Claimed' }, next: { ...sweep, claim: taken } };
  }
  if (claim.runId === payload.runId) return { result: { _tag: 'Claimed' }, next: null };
  return { result: { _tag: 'Busy' }, next: null };
};

/**
 * The owner's sweep done: its commit becomes the last sweep's and its leftovers the carry-over; a
 * stop before it is no longer the latest.
 * Answers whether the run finished it at that commit. A run retrying its finish once it landed is
 * answered as landed, whatever claim is held now; another run gets the owner's rules.
 */
export const finishSweep = ({
  sweep,
  payload,
  nowMs,
}: {
  readonly sweep: SweepRecord;
  readonly payload: FinishSweepPayload;
  readonly nowMs: number;
}): Decision<boolean> => {
  const { claim, last } = sweep;
  const isRepeat =
    last !== null && last.finishedBy === payload.runId && last.sha === payload.headSha;
  if (isRepeat) return { result: true, next: null };
  if (claim === null || claim.runId !== payload.runId || claim.headSha !== payload.headSha) {
    return { result: false, next: null };
  }
  const finished: SweepRecord = {
    threshold: sweep.threshold,
    last: {
      sha: payload.headSha,
      at: DateTime.makeUnsafe(nowMs),
      outcome: payload.outcome,
      finishedBy: payload.runId,
    },
    stopped: null,
    carryOver: payload.carryOver,
    claim: null,
  };
  return { result: true, next: finished };
};

/**
 * The owner's sweep stopped short: recorded as the latest, and its claim given up. The last sweep
 * stays, so the next counts from where the last finished one did. Anyone else's claim, or a stop
 * the run retries once it landed, is left alone.
 */
export const stopSweep = ({
  sweep,
  payload,
  nowMs,
}: {
  readonly sweep: SweepRecord;
  readonly payload: StopSweepPayload;
  readonly nowMs: number;
}): Decision<void> => {
  if (sweep.claim === null || sweep.claim.runId !== payload.runId) {
    return { result: undefined, next: null };
  }
  return {
    result: undefined,
    next: {
      ...sweep,
      stopped: { at: DateTime.makeUnsafe(nowMs), cause: payload.cause },
      claim: null,
    },
  };
};

/** The owner gave its claim up, with no sweep due: freed. Anyone else's is left alone. */
export const endSweep = ({
  sweep,
  payload,
}: {
  readonly sweep: SweepRecord;
  readonly payload: EndSweepPayload;
}): Decision<void> => {
  if (sweep.claim === null || sweep.claim.runId !== payload.runId) {
    return { result: undefined, next: null };
  }
  return { result: undefined, next: { ...sweep, claim: null } };
};

const sweepOf = (stored: Option.Option<StoredSweep>): SweepRecord =>
  Option.match(stored, { onNone: () => defaultSweep, onSome: ({ sweep }) => sweep });

export const SweepsApiLive = HttpApiBuilder.group(
  Api,
  'sweeps',
  Effect.fn('SweepsApiLive')(function* (handlers) {
    const store = yield* SweepStore;
    const users = yield* CachedGitLabUsers;

    /**
     * Decides on the project's sweep from the state it is in, and writes what the decision leaves
     * at the revision it was read at. A write that lost a race to another one decides again, from
     * the sweep that won.
     */
    const decideOn: <A>(
      projectId: string,
      decide: (sweep: SweepRecord, nowMs: number) => Decision<A>,
    ) => Effect.Effect<A> = Effect.fn('SweepsApi.decideOn')(function* (projectId, decide) {
      const stored = yield* store.get(projectId);
      const nowMs = yield* Clock.currentTimeMillis;
      const decision = decide(sweepOf(stored), nowMs);
      if (decision.next === null) return decision.result;
      const isWritten = yield* store.write({
        projectId,
        sweep: decision.next,
        expectedRevision: Option.map(stored, ({ revision }) => revision),
      });
      if (isWritten) return decision.result;
      return yield* decideOn(projectId, decide);
    });

    /** The project's own flow, the only caller that claims, finishes, stops and ends its sweep. */
    const assertFlowOfProject = Effect.fn('SweepsApi.assertFlowOfProject')(function* (
      projectId: string,
    ) {
      const caller = yield* CurrentCaller;
      if (caller._tag === 'Flow' && caller.projectId === projectId) return;
      return yield* new Forbidden({ message: 'only the flow of this project may sweep it' });
    });

    /** The project's own flow, or a developer who can read its code, may read its sweep. */
    const assertCanReadSweep = Effect.fn('SweepsApi.assertCanReadSweep')(function* (
      projectId: string,
    ) {
      const caller = yield* CurrentCaller;
      if (caller._tag === 'Flow') {
        if (caller.projectId !== projectId) {
          return yield* new Forbidden({ message: 'flow may only read its own project' });
        }
        return;
      }
      const canRead = yield* users.canReadCode({ token: caller.token, projectId });
      if (!canRead) {
        return yield* new Forbidden({ message: 'developer cannot read the code of this project' });
      }
    });

    /** Only a developer who can push to the project sets its threshold. */
    const assertCanSetThreshold = Effect.fn('SweepsApi.assertCanSetThreshold')(function* (
      projectId: string,
    ) {
      const caller = yield* CurrentCaller;
      if (caller._tag !== 'Developer') {
        return yield* new Forbidden({ message: 'only a developer may set the threshold' });
      }
      const canPush = yield* users.canPush({
        token: caller.token,
        projectId,
        userId: caller.userId,
      });
      if (!canPush) {
        return yield* new Forbidden({ message: 'developer cannot push to this project' });
      }
    });

    return handlers.handleAll({
      get: Effect.fn('SweepsApi.get')(function* ({ params }) {
        yield* assertCanReadSweep(params.projectId);
        const stored = yield* store.get(params.projectId);
        return sweepState(sweepOf(stored), yield* Clock.currentTimeMillis);
      }),

      putThreshold: Effect.fn('SweepsApi.putThreshold')(function* ({ params, payload }) {
        yield* assertCanSetThreshold(params.projectId);
        yield* decideOn(params.projectId, sweep => ({
          result: undefined,
          next: { ...sweep, threshold: payload.threshold },
        }));
      }),

      claim: Effect.fn('SweepsApi.claim')(function* ({ params, payload }) {
        yield* assertFlowOfProject(params.projectId);
        return yield* decideOn(params.projectId, (sweep, nowMs) =>
          claimSweep({ sweep, payload, nowMs }),
        );
      }),

      finish: Effect.fn('SweepsApi.finish')(function* ({ params, payload }) {
        yield* assertFlowOfProject(params.projectId);
        const isOwner = yield* decideOn(params.projectId, (sweep, nowMs) =>
          finishSweep({ sweep, payload, nowMs }),
        );
        if (!isOwner) {
          return yield* new NotClaimOwner({
            message: 'this run does not hold the sweep claim on this commit',
          });
        }
      }),

      stop: Effect.fn('SweepsApi.stop')(function* ({ params, payload }) {
        yield* assertFlowOfProject(params.projectId);
        yield* decideOn(params.projectId, (sweep, nowMs) => stopSweep({ sweep, payload, nowMs }));
      }),

      end: Effect.fn('SweepsApi.end')(function* ({ params, payload }) {
        yield* assertFlowOfProject(params.projectId);
        yield* decideOn(params.projectId, sweep => endSweep({ sweep, payload }));
      }),
    });
  }),
);
