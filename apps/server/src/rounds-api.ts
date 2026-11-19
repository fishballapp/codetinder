import {
  AlreadyLearned,
  AlreadyLearning,
  Api,
  AskIdSchema,
  CurrentCaller,
  EVIDENCE_ROUNDS,
  Forbidden,
  InvalidSwipes,
  makeRoundId,
  NotClaimOwner,
  RetryNotDue,
  type RoundId,
  RoundNotFound,
  RoundTooLarge,
} from '@codetinder/api';
import {
  principleEvidence,
  type Round,
  RoundSchema,
  testedPrinciples,
  type Verdicts,
} from '@codetinder/core';
import * as Clock from 'effect/Clock';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { CachedGitLabUsers } from './authentication';
import {
  applyReport,
  askToLearn,
  type Decision,
  type LearnInput,
  learnState,
  retryLearn,
  swipesSnapshot,
  tieNote,
} from './learn';
import { type CommitKey, RoundStore } from './round-store';

/** A Firestore document is at most 1 MiB; refuse above 900 KB so fields fit. */
export const ROUND_MAX_BYTES = 900 * 1024;

/** A fresh ask's id. */
const makeAskId = () => Schema.decodeSync(AskIdSchema)(crypto.randomUUID());

export const RoundsApiLive = HttpApiBuilder.group(
  Api,
  'rounds',
  Effect.fn('RoundsApiLive')(function* (handlers) {
    const store = yield* RoundStore;
    const users = yield* CachedGitLabUsers;

    const assertCanAccessProject = Effect.fn('RoundsApi.assertCanAccessProject')(function* (
      projectId: string,
    ) {
      const caller = yield* CurrentCaller;
      if (caller._tag === 'Flow') {
        if (caller.projectId !== projectId) {
          return yield* new Forbidden({ message: 'flow may only access its own project' });
        }
        return;
      }
      const canRead = yield* users.canReadCode({
        token: caller.token,
        projectId,
      });
      if (!canRead) {
        return yield* new Forbidden({ message: 'developer cannot read the code of this project' });
      }
    });

    /** Verdicts name cards of the round they are saved on; any other id is refused. */
    const assertKnownCards = Effect.fn('RoundsApi.assertKnownCards')(function* (
      round: Round,
      verdicts: Verdicts,
    ) {
      const cardIds = new Set(round.cards.map(({ id }) => id));
      const unknown = Object.keys(verdicts).filter(id => !cardIds.has(id));
      if (unknown.length === 0) return;
      return yield* new InvalidSwipes({
        message: `unknown card ids: ${unknown.join(', ')}`,
      });
    });

    /**
     * The run's claim on the commit: the round it already stored (the run's retry after a lost
     * answer gets the same round), or the revision a new round must be stored at. Refused when the
     * run doesn't hold a live claim on it.
     */
    const ownedClaim = Effect.fn('RoundsApi.ownedClaim')(function* (key: CommitKey, runId: string) {
      const claim = yield* store.getClaim(key);
      if (Option.isNone(claim) || claim.value.runId !== runId) {
        return yield* new NotClaimOwner({
          message: 'this run does not hold the claim on this commit',
        });
      }
      const { roundId, endedAt, revision } = claim.value;
      if (Option.isSome(roundId)) return { _tag: 'HasRound', roundId: roundId.value } as const;
      if (Option.isSome(endedAt)) {
        return yield* new NotClaimOwner({ message: 'this run gave up its claim on this commit' });
      }
      return { _tag: 'Open', revision } as const;
    });

    const getStored = Effect.fn('RoundsApi.getStored')(function* (id: RoundId) {
      const stored = yield* store.get(id);
      if (Option.isNone(stored)) {
        return yield* new RoundNotFound({ message: `round ${id} not found` });
      }
      return stored.value;
    });

    /** The round's latest ask, its swipes as they are now (see `swipesSnapshot`), and the time. */
    const readLearn = Effect.fn('RoundsApi.readLearn')(function* (id: RoundId) {
      const stored = yield* getStored(id);
      const swipes = swipesSnapshot((yield* store.listSwipes([id])).get(id) ?? []);
      const input: LearnInput = {
        ask: Option.getOrNull(stored.learn),
        swipes,
        nowMs: yield* Clock.currentTimeMillis,
      };
      return { input, stored };
    });

    /**
     * Decides on the round's ask from the state it is in, and writes what the decision leaves at
     * the revision it was read at. A write that lost a race to another decides again, from the ask
     * that won.
     */
    const decideOnLearn: <A>(
      id: RoundId,
      decide: (input: LearnInput) => Decision<A>,
    ) => Effect.Effect<A, RoundNotFound> = Effect.fn('RoundsApi.decideOnLearn')(
      function* (id, decide) {
        const { input, stored } = yield* readLearn(id);
        const decision = decide(input);
        if (decision.next === null) return decision.result;
        const isWritten = yield* store.writeLearn({
          roundId: id,
          learn: decision.next,
          expectedRevision: stored.revision,
        });
        if (isWritten) return decision.result;
        return yield* decideOnLearn(id, decide);
      },
    );

    /** A developer who can read the round's code: the only caller who asks it to be learned. */
    const assertDeveloperOfRound = Effect.fn('RoundsApi.assertDeveloperOfRound')(function* (
      id: RoundId,
    ) {
      const caller = yield* CurrentCaller;
      if (caller._tag !== 'Developer') {
        return yield* new Forbidden({ message: 'only a developer may ask to learn a round' });
      }
      yield* assertCanAccessProject((yield* getStored(id)).projectId);
    });

    return handlers.handleAll({
      create: Effect.fn('RoundsApi.create')(function* ({ payload }) {
        const caller = yield* CurrentCaller;
        if (caller._tag !== 'Flow') {
          return yield* new Forbidden({ message: 'only a flow may create a round' });
        }

        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(RoundSchema))(
          payload.round,
        ).pipe(Effect.orDie);
        if (new TextEncoder().encode(encoded).byteLength > ROUND_MAX_BYTES) {
          return yield* new RoundTooLarge({
            message: `round exceeds ${ROUND_MAX_BYTES} bytes`,
          });
        }

        const key = {
          projectId: caller.projectId,
          mergeRequestIid: payload.mergeRequestIid,
          headSha: payload.headSha,
        };
        const owned = yield* ownedClaim(key, payload.runId);
        if (owned._tag === 'HasRound') return { id: owned.roundId };

        const id = makeRoundId(crypto.getRandomValues(new Uint8Array(12)));
        const createdAt = DateTime.makeUnsafe(yield* Clock.currentTimeMillis);
        const isStored = yield* store.create({
          round: { ...key, id, round: payload.round, createdAt },
          expectedClaimRevision: owned.revision,
        });
        if (isStored) return { id };
        // The claim changed under this write: a retry of this very upload may have stored first.
        const after = yield* ownedClaim(key, payload.runId);
        if (after._tag === 'HasRound') return { id: after.roundId };
        return yield* new NotClaimOwner({ message: 'the claim on this commit changed' });
      }),

      getById: Effect.fn('RoundsApi.getById')(function* ({ params }) {
        const stored = yield* getStored(params.id);
        yield* assertCanAccessProject(stored.projectId);
        return {
          id: stored.id,
          projectId: stored.projectId,
          mergeRequestIid: stored.mergeRequestIid,
          round: stored.round,
          createdAt: stored.createdAt,
        };
      }),

      putSwipes: Effect.fn('RoundsApi.putSwipes')(function* ({ params, payload }) {
        const caller = yield* CurrentCaller;
        if (caller._tag !== 'Developer') {
          return yield* new Forbidden({ message: 'only a developer may save swipes' });
        }

        const stored = yield* getStored(params.id);
        yield* assertCanAccessProject(stored.projectId);
        yield* assertKnownCards(stored.round, payload.verdicts);

        const updatedAtMs = yield* Clock.currentTimeMillis;
        yield* store.putSwipes({
          roundId: params.id,
          projectId: stored.projectId,
          userId: caller.userId,
          username: caller.username,
          verdicts: payload.verdicts,
          updatedAt: DateTime.makeUnsafe(updatedAtMs),
        });
      }),

      getSwipes: Effect.fn('RoundsApi.getSwipes')(function* ({ params }) {
        const stored = yield* getStored(params.id);
        yield* assertCanAccessProject(stored.projectId);
        const swipes = (yield* store.listSwipes([params.id])).get(params.id) ?? [];
        return { swipes };
      }),

      getEvidence: Effect.fn('RoundsApi.getEvidence')(function* ({ params }) {
        const stored = yield* getStored(params.id);
        yield* assertCanAccessProject(stored.projectId);
        // ponytail: the newest rounds, then those before this one: learning a round long after
        // newer ones finds fewer before it, never wrong ones.
        const earlier = (yield* store.listRounds(stored.projectId, EVIDENCE_ROUNDS)).filter(
          ({ createdAt }) => DateTime.isLessThan(createdAt, stored.createdAt),
        );
        const swipes = yield* store.listSwipes(earlier.map(({ id }) => id));
        return {
          evidence: principleEvidence({
            principleIds: testedPrinciples(stored.round),
            rounds: earlier.map(({ id, round }) => ({ id, round, swipes: swipes.get(id) ?? [] })),
          }),
        };
      }),

      getMySwipes: Effect.fn('RoundsApi.getMySwipes')(function* ({ params }) {
        const caller = yield* CurrentCaller;
        if (caller._tag !== 'Developer') {
          return yield* new Forbidden({ message: 'only a developer has swipes' });
        }
        const stored = yield* getStored(params.id);
        yield* assertCanAccessProject(stored.projectId);
        const swipes = (yield* store.listSwipes([params.id])).get(params.id) ?? [];
        const callerSwipe = swipes.find(({ userId }) => userId === caller.userId);
        return callerSwipe?.verdicts ?? {};
      }),

      getLearn: Effect.fn('RoundsApi.getLearn')(function* ({ params }) {
        const { input, stored } = yield* readLearn(params.id);
        yield* assertCanAccessProject(stored.projectId);
        return learnState(input);
      }),

      recordDone: Effect.fn('RoundsApi.recordDone')(function* ({ params }) {
        yield* assertDeveloperOfRound(params.id);
        const asked = yield* decideOnLearn(params.id, input => askToLearn(input, makeAskId()));
        if (asked._tag === 'AlreadyLearned') {
          return yield* new AlreadyLearned({ message: 'these swipes are already learned' });
        }
        if (asked._tag === 'AlreadyLearning') {
          return yield* new AlreadyLearning({ message: 'these swipes are being learned' });
        }
        return { askId: asked.askId };
      }),

      retryLearn: Effect.fn('RoundsApi.retryLearn')(function* ({ params, payload }) {
        yield* assertDeveloperOfRound(params.id);
        const askId = yield* decideOnLearn(params.id, input =>
          retryLearn(input, { askId: payload.askId, id: makeAskId() }),
        );
        if (askId === null) {
          return yield* new RetryNotDue({ message: 'this ask is not one to ask again' });
        }
        return { askId };
      }),

      putAskNote: Effect.fn('RoundsApi.putAskNote')(function* ({ params, payload }) {
        yield* assertDeveloperOfRound(params.id);
        yield* decideOnLearn(params.id, input => tieNote(input, payload));
      }),

      reportLearn: Effect.fn('RoundsApi.reportLearn')(function* ({ params, payload }) {
        const caller = yield* CurrentCaller;
        const stored = yield* getStored(params.id);
        if (caller._tag !== 'Flow' || caller.projectId !== stored.projectId) {
          return yield* new Forbidden({ message: "only the round's project's flow may report" });
        }
        yield* decideOnLearn(params.id, input => applyReport(input, payload));
      }),
    });
  }),
);
