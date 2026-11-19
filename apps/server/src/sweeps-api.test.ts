import { DEFAULT_SWEEP_THRESHOLD } from '@codetinder/api';
import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type { SweepRecord } from './sweep-store';
import { claimSweep, endSweep, finishSweep, stopSweep, sweepState } from './sweeps-api';
import { asRecord, auth, json, withHandler } from './test-app';
import {
  FLOW_OTHER_TOKEN,
  FLOW_TOKEN,
  OAUTH_NO_ACCESS,
  OAUTH_TEAMMATE_TOKEN,
  OAUTH_TOKEN,
} from './test-fixtures';

type Handler = (request: Request) => Promise<Response>;

const RUN_A = '0f8fad5b-d9cb-469f-a165-70867728950a';
const RUN_B = '0f8fad5b-d9cb-469f-a165-70867728950b';
const SHA_A = 'c0ffee'.padEnd(40, '0');
const SHA_B = 'ab'.repeat(20);
const PROJECT = '111';

const send = (
  handler: Handler,
  method: 'GET' | 'PUT' | 'POST',
  token: string,
  path: string,
  body?: unknown,
) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost/api/sweeps/${PROJECT}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...auth(token),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ).then(json),
  );

const read = (handler: Handler, token = FLOW_TOKEN) => send(handler, 'GET', token, '');

const claim = (handler: Handler, runId: string, headSha = SHA_A, token = FLOW_TOKEN) =>
  send(handler, 'POST', token, '/claim', { runId, headSha });

const finish = (
  handler: Handler,
  runId: string,
  headSha = SHA_A,
  outcome: unknown = { _tag: 'Proposed', mergeRequestIid: 12 },
  token = FLOW_TOKEN,
) =>
  send(handler, 'POST', token, '/finish', {
    runId,
    headSha,
    outcome,
    carryOver: [{ file: 'src/a.ts', name: 'slowest' }],
  });

const end = (handler: Handler, runId: string, token = FLOW_TOKEN) =>
  send(handler, 'POST', token, '/end', { runId });

const stop = (handler: Handler, runId: string, token = FLOW_TOKEN) =>
  send(handler, 'POST', token, '/stop', { runId, cause: 'Answer' });

describe('SweepsApi', () => {
  it.effect('reads a project with no sweep as the defaults', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect(yield* read(handler)).toEqual({
          status: 200,
          body: {
            threshold: DEFAULT_SWEEP_THRESHOLD,
            last: null,
            stopped: null,
            carryOver: [],
            isRunning: false,
          },
        });
      }),
    ),
  );

  it.effect('reads a sweep to its flow and to a developer who can read the code', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect((yield* read(handler, OAUTH_TOKEN)).status).toBe(200);
        expect((yield* read(handler, OAUTH_TEAMMATE_TOKEN)).status).toBe(200);
        expect((yield* read(handler, OAUTH_NO_ACCESS)).status).toBe(403);
        expect((yield* read(handler, FLOW_OTHER_TOKEN)).status).toBe(403);
      }),
    ),
  );

  it.effect('sets the threshold for a developer who can push, and refuses the rest', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect(
          (yield* send(handler, 'PUT', OAUTH_TEAMMATE_TOKEN, '/threshold', { threshold: 300 }))
            .status,
        ).toBe(403);
        expect(
          (yield* send(handler, 'PUT', FLOW_TOKEN, '/threshold', { threshold: 300 })).status,
        ).toBe(403);
        expect(
          (yield* send(handler, 'PUT', OAUTH_TOKEN, '/threshold', { threshold: 99 })).status,
        ).toBe(400);

        expect(
          (yield* send(handler, 'PUT', OAUTH_TOKEN, '/threshold', { threshold: 300 })).status,
        ).toBe(204);
        expect(((yield* read(handler)).body as { threshold: number }).threshold).toBe(300);
      }),
    ),
  );

  it.effect('gives the sweep to one run at a time, and answers its owner asking again', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect((yield* claim(handler, RUN_A)).body).toEqual({ _tag: 'Claimed' });
        expect((yield* claim(handler, RUN_B, SHA_B)).body).toEqual({ _tag: 'Busy' });
        expect((yield* claim(handler, RUN_A)).body).toEqual({ _tag: 'Claimed' });
        expect(((yield* read(handler)).body as { isRunning: boolean }).isRunning).toBe(true);
      }),
    ),
  );

  it.effect('refuses a claim to a developer, or to the flow of another project', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        expect((yield* claim(handler, RUN_A, SHA_A, OAUTH_TOKEN)).status).toBe(403);
        expect((yield* claim(handler, RUN_A, SHA_A, FLOW_OTHER_TOKEN)).status).toBe(403);
        expect((yield* read(handler)).body).toMatchObject({ isRunning: false });
      }),
    ),
  );

  it.effect('records the finished sweep, replaces the carry-over and frees the claim', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        expect((yield* finish(handler, RUN_A)).status).toBe(204);

        expect((yield* read(handler)).body).toMatchObject({
          last: {
            sha: SHA_A,
            at: expect.any(String),
            outcome: { _tag: 'Proposed', mergeRequestIid: 12 },
          },
          carryOver: [{ file: 'src/a.ts', name: 'slowest' }],
          isRunning: false,
        });
      }),
    ),
  );

  it.effect('refuses a finish from a run that does not own the sweep, or on another commit', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        const other = yield* finish(handler, RUN_B);
        expect(other.status).toBe(409);
        expect(other.body).toMatchObject({ _tag: 'NotClaimOwner' });
        expect((yield* finish(handler, RUN_A, SHA_B)).status).toBe(409);
        expect((yield* read(handler)).body).toMatchObject({ last: null, isRunning: true });
      }),
    ),
  );

  it.effect('answers the finishing run retrying its finish as landed, whatever claim is held', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        yield* finish(handler, RUN_A);
        const before = yield* read(handler);

        yield* claim(handler, RUN_B, SHA_B);
        expect((yield* finish(handler, RUN_A)).status).toBe(204);
        expect((yield* read(handler)).body).toEqual({
          ...asRecord(before.body),
          isRunning: true,
        });
      }),
    ),
  );

  it.effect('refuses another run finishing the same commit with no claim held', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        yield* finish(handler, RUN_A);

        const other = yield* finish(handler, RUN_B);
        expect(other.status).toBe(409);
        expect(other.body).toMatchObject({ _tag: 'NotClaimOwner' });
      }),
    ),
  );
  it.effect('ends the claim of its owner and leaves another run claim claim alone', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        expect((yield* end(handler, RUN_B)).status).toBe(204);
        expect((yield* read(handler)).body).toMatchObject({ isRunning: true });

        expect((yield* end(handler, RUN_A)).status).toBe(204);
        expect((yield* read(handler)).body).toMatchObject({ isRunning: false, last: null });
        expect((yield* claim(handler, RUN_B)).body).toEqual({ _tag: 'Claimed' });
      }),
    ),
  );

  it.effect('records a stopped sweep beside the last finished one, until the next finishes', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        yield* finish(handler, RUN_A);
        yield* claim(handler, RUN_B, SHA_B);
        expect((yield* stop(handler, RUN_B)).status).toBe(204);
        expect((yield* read(handler)).body).toMatchObject({
          last: { sha: SHA_A, outcome: { _tag: 'Proposed', mergeRequestIid: 12 } },
          stopped: { at: expect.any(String), cause: 'Answer' },
          carryOver: [{ file: 'src/a.ts', name: 'slowest' }],
          isRunning: false,
        });

        yield* claim(handler, RUN_A, SHA_B);
        yield* finish(handler, RUN_A, SHA_B);
        expect((yield* read(handler)).body).toMatchObject({ last: { sha: SHA_B }, stopped: null });
      }),
    ),
  );

  it.effect('refuses a developer the claim, finish, stop and end of a flow', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* claim(handler, RUN_A);
        expect((yield* finish(handler, RUN_A, SHA_A, undefined, OAUTH_TOKEN)).status).toBe(403);
        expect((yield* stop(handler, RUN_A, OAUTH_TOKEN)).status).toBe(403);
        expect((yield* end(handler, RUN_A, OAUTH_TOKEN)).status).toBe(403);
      }),
    ),
  );
});

const record = (fill: Partial<SweepRecord> = {}): SweepRecord => ({
  threshold: DEFAULT_SWEEP_THRESHOLD,
  last: null,
  stopped: null,
  carryOver: [],
  claim: null,
  ...fill,
});

const claimedAt = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');
const minutesAfter = (minutes: number) =>
  DateTime.toEpochMillis(claimedAt) + Duration.toMillis(Duration.minutes(minutes));
const heldBy = (runId: string) => record({ claim: { runId, headSha: SHA_A, claimedAt } });

describe('sweep decisions', () => {
  it('holds a claim for 101 minutes, then lets a new run take it over', () => {
    const held = heldBy(RUN_A);
    expect(
      claimSweep({
        sweep: held,
        payload: { runId: RUN_B, headSha: SHA_B },
        nowMs: minutesAfter(100),
      }),
    ).toEqual({ result: { _tag: 'Busy' }, next: null });
    expect(sweepState(held, minutesAfter(100)).isRunning).toBe(true);
    expect(sweepState(held, minutesAfter(101)).isRunning).toBe(false);

    const retaken = claimSweep({
      sweep: held,
      payload: { runId: RUN_B, headSha: SHA_B },
      nowMs: minutesAfter(101),
    });
    expect(retaken.result).toEqual({ _tag: 'Claimed' });
    expect(retaken.next?.claim).toEqual({
      runId: RUN_B,
      headSha: SHA_B,
      claimedAt: DateTime.makeUnsafe(minutesAfter(101)),
    });
  });

  it('does not write a repeated claim by the owner, keeping when it was taken', () => {
    const held = heldBy(RUN_A);
    expect(
      claimSweep({
        sweep: held,
        payload: { runId: RUN_A, headSha: SHA_A },
        nowMs: minutesAfter(1),
      }),
    ).toEqual({ result: { _tag: 'Claimed' }, next: null });
  });

  it('ends only the claim of its owner', () => {
    expect(endSweep({ sweep: heldBy(RUN_A), payload: { runId: RUN_B } }).next).toBeNull();
    expect(endSweep({ sweep: heldBy(RUN_A), payload: { runId: RUN_A } }).next?.claim).toBeNull();
  });

  it('records the stop of its owner only, keeping the last sweep and the carry-over', () => {
    const last = {
      sha: SHA_A,
      at: claimedAt,
      outcome: { _tag: 'Clean' } as const,
      finishedBy: RUN_B,
    };
    const carryOver = [{ file: 'src/a.ts', name: 'slowest' }];
    const held = record({ last, carryOver, claim: { runId: RUN_A, headSha: SHA_B, claimedAt } });
    const nowMs = minutesAfter(1);
    expect(
      stopSweep({ sweep: held, payload: { runId: RUN_B, cause: 'Tests' }, nowMs }).next,
    ).toBeNull();
    expect(
      stopSweep({ sweep: held, payload: { runId: RUN_A, cause: 'Tests' }, nowMs }).next,
    ).toEqual({
      ...held,
      stopped: { at: DateTime.makeUnsafe(nowMs), cause: 'Tests' },
      claim: null,
    });
  });

  it('finishes the sweep of its owner at its commit only', () => {
    const outcome = { _tag: 'Clean' } as const;
    const nowMs = minutesAfter(1);
    expect(
      finishSweep({
        sweep: heldBy(RUN_A),
        payload: { runId: RUN_A, headSha: SHA_B, outcome, carryOver: [] },
        nowMs,
      }).result,
    ).toBe(false);
    const finished = finishSweep({
      sweep: heldBy(RUN_A),
      payload: { runId: RUN_A, headSha: SHA_A, outcome, carryOver: [] },
      nowMs,
    });
    expect(finished.result).toBe(true);
    expect(finished.next).toEqual({
      threshold: DEFAULT_SWEEP_THRESHOLD,
      last: { sha: SHA_A, at: DateTime.makeUnsafe(nowMs), outcome, finishedBy: RUN_A },
      stopped: null,
      carryOver: [],
      claim: null,
    });
  });
});
