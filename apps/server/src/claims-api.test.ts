import { makeRoundId } from '@codetinder/api';
import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { claimDecision } from './claims-api';
import type { Claim } from './round-store';
import { asRecord, auth, json, withHandler } from './test-app';
import { FLOW_OTHER_TOKEN, FLOW_TOKEN, HEAD_SHA, OAUTH_TOKEN, sampleRound } from './test-fixtures';

type Handler = (request: Request) => Promise<Response>;

const RUN_A = '0f8fad5b-d9cb-469f-a165-70867728950a';
const RUN_B = '0f8fad5b-d9cb-469f-a165-70867728950b';
const RUN_C = '0f8fad5b-d9cb-469f-a165-70867728950c';

const post = (handler: Handler, token: string, path: string, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: JSON.stringify(body),
      }),
    ).then(json),
  );

const commit = { mergeRequestIid: 7, headSha: HEAD_SHA };

/** A run's claim on the commit, as its client sends it (and sends it again after a lost answer). */
const claim = (handler: Handler, runId: string, event: string, token = FLOW_TOKEN) =>
  post(handler, token, '/api/claims', { ...commit, runId, event });

/** A run's claim for a developer's ask, naming its note as every session of the ask does. */
const ask = (handler: Handler, runId: string, event: string, askNoteId: number) =>
  post(handler, FLOW_TOKEN, '/api/claims', { ...commit, runId, event, askNoteId });

// The notes of three asks, in the order the developer made them.
const ASK_1 = 101;
const ASK_2 = 102;
const ASK_3 = 103;

const get = (handler: Handler, path: string) =>
  Effect.promise(() =>
    handler(new Request(`http://localhost${path}`, { headers: auth(FLOW_TOKEN) })).then(json),
  );

const end = (handler: Handler, runId: string) =>
  post(handler, FLOW_TOKEN, '/api/claims/end', { ...commit, runId });

const upload = (handler: Handler, runId: string) =>
  post(handler, FLOW_TOKEN, '/api/rounds', { ...commit, runId, round: sampleRound });

describe('ClaimsApi', () => {
  it.effect('gives a commit to the first run, and tells a duplicate another run is on it', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect(yield* claim(handler, RUN_A, 'merge_request')).toEqual({
          status: 200,
          body: { _tag: 'Claimed' },
        });
        for (const event of ['pipeline_hooks', 'assign_reviewer']) {
          expect((yield* claim(handler, RUN_B, event)).body).toEqual({ _tag: 'Busy' });
        }
      }),
    ),
  );

  it.effect('answers the owner repeating its claim, as after a lost answer, with Claimed', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const first = yield* claim(handler, RUN_A, 'pipeline_hooks');
        const retried = yield* claim(handler, RUN_A, 'pipeline_hooks');
        expect([first.body, retried.body]).toEqual([{ _tag: 'Claimed' }, { _tag: 'Claimed' }]);
        expect((yield* claim(handler, RUN_B, 'pipeline_hooks')).body).toEqual({ _tag: 'Busy' });
      }),
    ),
  );

  it.effect('gives a commit to exactly one of two runs claiming at once, and both of one run', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const racing = yield* Effect.all(
          [claim(handler, RUN_A, 'merge_request'), claim(handler, RUN_B, 'merge_request')],
          { concurrency: 'unbounded' },
        );
        expect(racing.map(({ body }) => body)).toContainEqual({ _tag: 'Busy' });
        expect(racing.map(({ body }) => body)).toContainEqual({ _tag: 'Claimed' });

        // One run's request and its retry racing, on another project's commit.
        const retried = yield* Effect.all(
          [
            claim(handler, RUN_C, 'merge_request', FLOW_OTHER_TOKEN),
            claim(handler, RUN_C, 'merge_request', FLOW_OTHER_TOKEN),
          ],
          { concurrency: 'unbounded' },
        );
        expect(retried.map(({ body }) => body)).toEqual([{ _tag: 'Claimed' }, { _tag: 'Claimed' }]);
      }),
    ),
  );

  it.effect(
    'stores one round for the owner however often it uploads, and refuses anyone else',
    () =>
      withHandler(handler =>
        Effect.gen(function* () {
          yield* claim(handler, RUN_A, 'merge_request');
          const first = yield* upload(handler, RUN_A);
          const retried = yield* upload(handler, RUN_A);
          expect(first.status).toBe(200);
          expect(retried).toEqual(first);
          const racing = yield* Effect.all([upload(handler, RUN_A), upload(handler, RUN_A)], {
            concurrency: 'unbounded',
          });
          expect(racing).toEqual([first, first]);

          expect((yield* upload(handler, RUN_B)).status).toBe(409);
          expect((yield* claim(handler, RUN_B, 'assign_reviewer')).body).toEqual({
            _tag: 'HasRound',
            roundId: (first.body as { id: string }).id,
          });
        }),
      ),
  );

  it.effect('stores one round when the owner uploads twice at once, before any is stored', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A, 'merge_request');
        const [one, two] = yield* Effect.all([upload(handler, RUN_A), upload(handler, RUN_A)], {
          concurrency: 'unbounded',
        });
        expect(one?.status).toBe(200);
        expect(two).toEqual(one);
      }),
    ),
  );

  it.effect('refuses a round for a commit nobody claimed', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect((yield* upload(handler, RUN_A)).status).toBe(409);
      }),
    ),
  );

  it.effect('ignores a stale end that would release a claim another run took since', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A, 'merge_request');
        expect((yield* end(handler, RUN_A)).status).toBe(204);
        expect((yield* ask(handler, RUN_B, 'assign_reviewer', ASK_1)).body).toEqual({
          _tag: 'Claimed',
        });

        // A's end arrives again: a retry after its answer was lost.
        expect((yield* end(handler, RUN_A)).status).toBe(204);
        expect((yield* ask(handler, RUN_C, 'assign_reviewer', ASK_2)).body).toEqual({
          _tag: 'Busy',
        });
        expect((yield* upload(handler, RUN_A)).status).toBe(409);
        expect((yield* upload(handler, RUN_B)).status).toBe(200);
      }),
    ),
  );

  it.effect('retries an ended attempt only for a new ask, under the new run', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* ask(handler, RUN_A, 'assign_reviewer', ASK_1);
        yield* end(handler, RUN_A);
        for (const event of ['merge_request', 'merge_request_ready', 'pipeline_hooks']) {
          expect((yield* ask(handler, RUN_C, event, ASK_2)).body).toEqual({ _tag: 'Tried' });
        }
        // A duplicate session of the ask that tried, and an ask that names no note.
        expect((yield* ask(handler, RUN_C, 'assign_reviewer', ASK_1)).body).toEqual({
          _tag: 'Tried',
        });
        expect((yield* claim(handler, RUN_C, 'mention')).body).toEqual({ _tag: 'Tried' });

        for (let attempt = 0; attempt < 2; attempt++) {
          expect((yield* ask(handler, RUN_B, 'mention', ASK_2)).body).toEqual({ _tag: 'Claimed' });
        }
        expect((yield* ask(handler, RUN_C, 'mention', ASK_2)).body).toEqual({ _tag: 'Busy' });
        expect((yield* ask(handler, RUN_C, 'assign_reviewer', ASK_3)).body).toEqual({
          _tag: 'Busy',
        });
      }),
    ),
  );

  it.effect("makes a new ask's round the commit's, keeping the round it replaces", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* ask(handler, RUN_A, 'mention', ASK_1);
        const replaced = asRecord((yield* upload(handler, RUN_A)).body).id;

        // A duplicate session of the mention that made the round, and automatic events.
        expect((yield* ask(handler, RUN_C, 'mention', ASK_1)).body).toEqual({
          _tag: 'HasRound',
          roundId: replaced,
        });
        for (const event of ['merge_request', 'pipeline_hooks']) {
          expect((yield* ask(handler, RUN_C, event, ASK_2)).body).toEqual({
            _tag: 'HasRound',
            roundId: replaced,
          });
        }
        // The owner asking again, after its round, as after a lost answer.
        expect((yield* ask(handler, RUN_A, 'mention', ASK_1)).body).toEqual({ _tag: 'Claimed' });

        // Seconds later, a second mention.
        expect((yield* ask(handler, RUN_B, 'mention', ASK_2)).body).toEqual({
          _tag: 'Claimed',
          replacedRoundId: replaced,
        });
        expect((yield* ask(handler, RUN_C, 'mention', ASK_2)).body).toEqual({ _tag: 'Busy' });
        expect((yield* upload(handler, RUN_A)).status).toBe(409);
        const fresh = asRecord((yield* upload(handler, RUN_B)).body).id;
        expect(fresh).not.toEqual(replaced);
        expect((yield* ask(handler, RUN_C, 'mention', ASK_2)).body).toEqual({
          _tag: 'HasRound',
          roundId: fresh,
        });
        expect((yield* get(handler, `/api/rounds/${replaced}`)).status).toBe(200);

        // A reviewer's request replaces it in turn.
        expect((yield* ask(handler, RUN_C, 'assign_reviewer', ASK_3)).body).toEqual({
          _tag: 'Claimed',
          replacedRoundId: fresh,
        });
      }),
    ),
  );

  it.effect("answers a delayed session of an older ask with the newer ask's round", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        // Mention 101 makes a round; mention 102 replaces it and finishes.
        yield* ask(handler, RUN_A, 'mention', ASK_1);
        yield* upload(handler, RUN_A);
        yield* ask(handler, RUN_B, 'mention', ASK_2);
        const fresh = asRecord((yield* upload(handler, RUN_B)).body).id;

        // A delayed session of mention 101, and a reviewer session naming the older request.
        for (const event of ['mention', 'assign_reviewer']) {
          expect((yield* ask(handler, RUN_C, event, ASK_1)).body).toEqual({
            _tag: 'HasRound',
            roundId: fresh,
          });
        }
        expect((yield* ask(handler, RUN_C, 'assign_reviewer', ASK_3)).body).toEqual({
          _tag: 'Claimed',
          replacedRoundId: fresh,
        });
      }),
    ),
  );

  it.effect('makes one round for an MR opened with CodeTinder as its reviewer', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        // Both events name the reviewer request made with the MR; either may claim first.
        for (const [first, second] of [
          ['merge_request', 'assign_reviewer'],
          ['assign_reviewer', 'merge_request'],
        ] as const) {
          const headSha = first === 'merge_request' ? HEAD_SHA : 'b'.repeat(40);
          const claimAt = (runId: string, event: string) =>
            post(handler, FLOW_TOKEN, '/api/claims', {
              ...commit,
              headSha,
              runId,
              event,
              askNoteId: ASK_1,
            });
          expect((yield* claimAt(RUN_A, first)).body).toEqual({ _tag: 'Claimed' });
          expect((yield* claimAt(RUN_B, second)).body).toEqual({ _tag: 'Busy' });
          // The first ends at once (a change with no code), before the second asks again.
          yield* post(handler, FLOW_TOKEN, '/api/claims/end', { ...commit, headSha, runId: RUN_A });
          expect((yield* claimAt(RUN_C, second)).body).toEqual({ _tag: 'Tried' });
        }
      }),
    ),
  );

  it.effect("keeps each project's claims apart", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A, 'merge_request');
        expect((yield* claim(handler, RUN_B, 'merge_request', FLOW_OTHER_TOKEN)).body).toEqual({
          _tag: 'Claimed',
        });
      }),
    ),
  );

  it.effect('forbids a developer', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect((yield* claim(handler, RUN_A, 'merge_request', OAUTH_TOKEN)).status).toBe(403);
        const ended = yield* post(handler, OAUTH_TOKEN, '/api/claims/end', {
          ...commit,
          runId: RUN_A,
        });
        expect(ended.status).toBe(403);
      }),
    ),
  );

  it.effect('refuses a head that is not a commit id, or a run id that is not a UUID', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        for (const body of [
          { ...commit, headSha: 'main', runId: RUN_A, event: 'merge_request' },
          { ...commit, runId: 'run-a', event: 'merge_request' },
        ]) {
          expect((yield* post(handler, FLOW_TOKEN, '/api/claims', body)).status).toBe(400);
        }
      }),
    ),
  );
});

describe('claimDecision', () => {
  const claimedAt = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');
  const claimedAtMs = DateTime.toEpochMillis(claimedAt);
  const held: Claim = {
    projectId: '111',
    mergeRequestIid: 7,
    headSha: HEAD_SHA,
    runId: RUN_A,
    claimedAt,
    askNoteId: Option.some(ASK_1),
    endedAt: Option.none(),
    roundId: Option.none(),
    revision: 'r1',
  };
  const MINUTE = 60_000;
  const roundId = makeRoundId(new Uint8Array(12).fill(3));
  const withRound = { ...held, roundId: Option.some(roundId) };
  const ended = { ...held, endedAt: Option.some(claimedAt) };
  const ASKS = ['assign_reviewer', 'mention'] as const;
  const AUTOMATIC = ['merge_request', 'merge_request_ready', 'pipeline_hooks'] as const;
  type Event = (typeof ASKS | typeof AUTOMATIC)[number];
  const decide = (
    claim: Claim,
    event: Event,
    askNoteId: Option.Option<number>,
    { runId = RUN_B, nowMs = claimedAtMs + MINUTE } = {},
  ) => claimDecision({ claim, runId, event, askNoteId, nowMs });

  it('answers the owner Claimed, however long and whatever came of its claim', () => {
    for (const claim of [held, withRound, ended]) {
      expect(
        decide(claim, 'merge_request', Option.none(), {
          runId: RUN_A,
          nowMs: claimedAtMs + 99 * MINUTE,
        }),
      ).toEqual({ _tag: 'Claimed' });
    }
  });

  it("keeps another run's running claim for 81 minutes, then lets any run retake it", () => {
    for (const event of ['merge_request', ...ASKS] as const) {
      const at = (nowMs: number) => decide(held, event, Option.some(ASK_2), { nowMs });
      expect(at(claimedAtMs + 80 * MINUTE)).toEqual({ _tag: 'Busy' });
      expect(at(claimedAtMs + 81 * MINUTE)).toEqual({
        _tag: 'Retake',
        replacedRoundId: Option.none(),
      });
    }
  });

  it('answers the round to an automatic event, and to a duplicate of the ask it answers', () => {
    for (const event of AUTOMATIC) {
      expect(decide(withRound, event, Option.some(ASK_2))).toEqual({ _tag: 'HasRound', roundId });
    }
    for (const event of ASKS) {
      for (const askNoteId of [Option.some(ASK_1), Option.none()]) {
        expect(decide(withRound, event, askNoteId)).toEqual({ _tag: 'HasRound', roundId });
      }
    }
  });

  it('replaces the round for a new ask, and for any ask on a claim that answers none', () => {
    for (const event of ASKS) {
      for (const claim of [withRound, { ...withRound, askNoteId: Option.none() }]) {
        expect(decide(claim, event, Option.some(ASK_2))).toEqual({
          _tag: 'Retake',
          replacedRoundId: Option.some(roundId),
        });
      }
    }
  });

  it('stays quiet for an older ask than the one the claim answers, as a delayed session', () => {
    const answersAsk2 = { ...withRound, askNoteId: Option.some(ASK_2) };
    for (const event of ASKS) {
      for (const claim of [
        answersAsk2,
        { ...answersAsk2, roundId: Option.none(), endedAt: Option.some(claimedAt) },
      ]) {
        expect(decide(claim, event, Option.some(ASK_1))).not.toMatchObject({ _tag: 'Retake' });
      }
      expect(decide(answersAsk2, event, Option.some(ASK_3))).toEqual({
        _tag: 'Retake',
        replacedRoundId: Option.some(roundId),
      });
    }
  });

  it('retries an ended attempt for a new ask, never for an automatic event or a duplicate', () => {
    for (const event of ASKS) {
      expect(decide(ended, event, Option.some(ASK_2))).toEqual({
        _tag: 'Retake',
        replacedRoundId: Option.none(),
      });
      expect(decide(ended, event, Option.some(ASK_1))).toEqual({ _tag: 'Tried' });
    }
    for (const event of AUTOMATIC) {
      expect(decide(ended, event, Option.some(ASK_2))).toEqual({ _tag: 'Tried' });
    }
  });
});
