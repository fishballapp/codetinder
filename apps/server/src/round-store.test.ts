import { makeRoundId } from '@codetinder/api';
import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { type NewRound, RoundStore } from './round-store';
import { sampleAsk, sampleRound } from './test-fixtures';

const storedRound = (fill: number, projectId: string, createdAt: string): NewRound => ({
  id: makeRoundId(new Uint8Array(12).fill(fill)),
  projectId,
  mergeRequestIid: 7,
  headSha: String(fill).repeat(40),
  round: sampleRound,
  createdAt: DateTime.makeUnsafe(createdAt),
});

const RUN_A = '0f8fad5b-d9cb-469f-a165-70867728950a';
const RUN_B = '0f8fad5b-d9cb-469f-a165-70867728950b';

/** Stores a round as the API does: claimed for its commit first, then stored at that claim. */
const storeClaimed = (round: NewRound) =>
  Effect.gen(function* () {
    const store = yield* RoundStore;
    yield* store.createClaim({
      key: round,
      runId: RUN_A,
      claimedAt: round.createdAt,
      askNoteId: Option.none(),
    });
    const claim = Option.getOrThrow(yield* store.getClaim(round));
    expect(yield* store.create({ round, expectedClaimRevision: claim.revision })).toBe(true);
  });

describe('RoundStore.memory', () => {
  it.effect("lists a project's rounds newest first, up to the limit", () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const oldest = storedRound(1, '111', '2026-01-01T00:00:00.000Z');
      const newest = storedRound(2, '111', '2026-01-03T00:00:00.000Z');
      const middle = storedRound(3, '111', '2026-01-02T00:00:00.000Z');
      const otherProject = storedRound(4, '222', '2026-01-04T00:00:00.000Z');
      for (const round of [oldest, newest, middle, otherProject]) {
        yield* storeClaimed(round);
      }

      const listed = yield* store.listRounds('111', 2);
      expect(listed.map(({ id }) => id)).toEqual([newest.id, middle.id]);
    }).pipe(Effect.provide(RoundStore.memory)),
  );

  it.effect('creates a round with no ask, and writes an ask only at the revision read', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const round = storedRound(5, '111', '2026-01-01T00:00:00.000Z');
      yield* storeClaimed(round);
      const created = Option.getOrThrow(yield* store.get(round.id));
      expect(created.learn).toEqual(Option.none());

      const written = yield* store.writeLearn({
        roundId: round.id,
        learn: sampleAsk,
        expectedRevision: created.revision,
      });
      expect(written).toBe(true);
      const asked = Option.getOrThrow(yield* store.get(round.id));
      expect(asked.learn).toEqual(Option.some(sampleAsk));
      expect(asked.revision).not.toBe(created.revision);

      const stale = yield* store.writeLearn({
        roundId: round.id,
        learn: { ...sampleAsk, noteId: 901 },
        expectedRevision: created.revision,
      });
      expect(stale).toBe(false);
      const unchanged = Option.getOrThrow(yield* store.get(round.id));
      expect(unchanged.learn).toEqual(Option.some(sampleAsk));
    }).pipe(Effect.provide(RoundStore.memory)),
  );
});

describe('RoundStore.memory claims', () => {
  const key = { projectId: '111', mergeRequestIid: 7, headSha: '9'.repeat(40) };
  const claimedAt = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');
  const round = { ...storedRound(9, '111', '2026-01-01T00:10:00.000Z'), ...key };

  it.effect('gives a commit to exactly one of the runs racing to claim it', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const results = yield* Effect.all(
        Array.from({ length: 5 }, () =>
          store.createClaim({ key, runId: RUN_A, claimedAt, askNoteId: Option.none() }),
        ),
        { concurrency: 'unbounded' },
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(Option.getOrThrow(yield* store.getClaim(key)).runId).toBe(RUN_A);
    }).pipe(Effect.provide(RoundStore.memory)),
  );

  it.effect('gives a retaken claim to exactly one new run, forgetting its ending', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      yield* store.createClaim({ key, runId: RUN_A, claimedAt, askNoteId: Option.none() });
      const held = Option.getOrThrow(yield* store.getClaim(key));
      yield* store.endClaim({ key, endedAt: claimedAt, expectedRevision: held.revision });
      const ended = Option.getOrThrow(yield* store.getClaim(key));
      expect(Option.isSome(ended.endedAt)).toBe(true);

      const retakenAt = DateTime.makeUnsafe('2026-01-01T01:00:00.000Z');
      const results = yield* Effect.all(
        Array.from({ length: 3 }, () =>
          store.retakeClaim({
            key,
            runId: RUN_B,
            claimedAt: retakenAt,
            askNoteId: Option.none(),
            expectedRevision: ended.revision,
          }),
        ),
        { concurrency: 'unbounded' },
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(Option.getOrThrow(yield* store.getClaim(key))).toMatchObject({
        runId: RUN_B,
        claimedAt: retakenAt,
        endedAt: Option.none(),
      });
    }).pipe(Effect.provide(RoundStore.memory)),
  );

  it.effect('stores one round per claim revision: a second write from it changes nothing', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      yield* store.createClaim({ key, runId: RUN_A, claimedAt, askNoteId: Option.none() });
      const held = Option.getOrThrow(yield* store.getClaim(key));
      const second = { ...round, id: makeRoundId(new Uint8Array(12).fill(8)) };
      const results = yield* Effect.all(
        [round, second].map(each =>
          store.create({ round: each, expectedClaimRevision: held.revision }),
        ),
        { concurrency: 'unbounded' },
      );
      expect(results).toEqual([true, false]);
      expect(Option.getOrThrow(yield* store.getClaim(key)).roundId).toEqual(Option.some(round.id));
      expect(yield* store.get(second.id)).toEqual(Option.none());
    }).pipe(Effect.provide(RoundStore.memory)),
  );

  it.effect('ends a claim only at the revision read, so a stale end never lands on a retake', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      yield* store.createClaim({ key, runId: RUN_A, claimedAt, askNoteId: Option.none() });
      const held = Option.getOrThrow(yield* store.getClaim(key));
      expect(
        yield* store.endClaim({ key, endedAt: claimedAt, expectedRevision: held.revision }),
      ).toBe(true);
      const ended = Option.getOrThrow(yield* store.getClaim(key));
      yield* store.retakeClaim({
        key,
        runId: RUN_B,
        claimedAt,
        askNoteId: Option.none(),
        expectedRevision: ended.revision,
      });

      expect(
        yield* store.endClaim({ key, endedAt: claimedAt, expectedRevision: held.revision }),
      ).toBe(false);
      expect(Option.getOrThrow(yield* store.getClaim(key)).endedAt).toEqual(Option.none());
    }).pipe(Effect.provide(RoundStore.memory)),
  );

  it.effect('ends no claim that is missing', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      expect(yield* store.endClaim({ key, endedAt: claimedAt, expectedRevision: 'r' })).toBe(false);
      expect(yield* store.getClaim(key)).toEqual(Option.none());
    }).pipe(Effect.provide(RoundStore.memory)),
  );
});
