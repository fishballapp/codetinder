import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { SweepStore } from './sweep-store';

const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const DOCUMENTS_URL =
  'https://firestore.googleapis.com/v1/projects/codetinder/databases/(default)/documents';
const DOCUMENT_NAME_PREFIX = 'projects/codetinder/databases/(default)/documents';
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withFirestore = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(SweepStore.firestore, Layer.succeed(FetchHttpClient.Fetch, fetch));

const metadataToken = () =>
  new Response(
    JSON.stringify({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' }),
    { status: 200 },
  );

const claimedAt = '2026-01-01T00:00:00.000Z';
const lastJson = JSON.stringify({
  sha: HEAD_SHA,
  at: '2026-01-02T00:00:00.000Z',
  outcome: { _tag: 'Proposed', mergeRequestIid: 12 },
  finishedBy: RUN_ID,
});
const stoppedJson = JSON.stringify({ at: '2026-01-03T00:00:00.000Z', cause: 'Answer' });
const carryOverJson = JSON.stringify([{ file: 'src/a.ts', name: 'slowest' }]);
const claimJson = JSON.stringify({ runId: RUN_ID, headSha: HEAD_SHA, claimedAt });

describe('SweepStore.firestore', () => {
  it.effect('reads a sweep document as the sweep it stores, and none on a miss', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      expect(yield* store.get('111')).toEqual(Option.none());
      expect(yield* store.get('222')).toEqual(
        Option.some({
          sweep: {
            threshold: 300,
            last: {
              sha: HEAD_SHA,
              at: DateTime.makeUnsafe('2026-01-02T00:00:00.000Z'),
              outcome: { _tag: 'Proposed', mergeRequestIid: 12 },
              finishedBy: RUN_ID,
            },
            stopped: { at: DateTime.makeUnsafe('2026-01-03T00:00:00.000Z'), cause: 'Answer' },
            carryOver: [{ file: 'src/a.ts', name: 'slowest' }],
            claim: {
              runId: RUN_ID,
              headSha: HEAD_SHA,
              claimedAt: DateTime.makeUnsafe(claimedAt),
            },
          },
          revision: 'rev-1',
        }),
      );
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            expect(request.method).toBe('GET');
            expect(request.headers.get('authorization')).toBe('Bearer ya29.test');
            if (request.url === `${DOCUMENTS_URL}/sweeps/111`) {
              return new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 });
            }
            expect(request.url).toBe(`${DOCUMENTS_URL}/sweeps/222`);
            return new Response(
              JSON.stringify({
                name: `${DOCUMENT_NAME_PREFIX}/sweeps/222`,
                fields: {
                  threshold: { integerValue: '300' },
                  carryOver: { stringValue: carryOverJson },
                  last: { stringValue: lastJson },
                  stopped: { stringValue: stoppedJson },
                  claim: { stringValue: claimJson },
                },
                updateTime: 'rev-1',
              }),
              { status: 200 },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('creates a sweep whole, only while the document is absent', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      const sweep = {
        threshold: 300,
        last: null,
        stopped: null,
        carryOver: [],
        claim: null,
      };
      expect(yield* store.write({ projectId: '111', sweep, expectedRevision: Option.none() })).toBe(
        true,
      );
      expect(yield* store.write({ projectId: '111', sweep, expectedRevision: Option.none() })).toBe(
        false,
      );
    }).pipe(
      Effect.provide(
        withFirestore(
          (() => {
            let isCreated = false;
            return scriptedFetch(async request => {
              if (request.url === METADATA_URL) return metadataToken();
              expect(request.url).toBe(`${DOCUMENTS_URL}:commit`);
              expect(await request.json()).toEqual({
                writes: [
                  {
                    update: {
                      name: `${DOCUMENT_NAME_PREFIX}/sweeps/111`,
                      fields: {
                        threshold: { integerValue: '300' },
                        carryOver: { stringValue: '[]' },
                      },
                    },
                    currentDocument: { exists: false },
                  },
                ],
              });
              if (isCreated) {
                return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), {
                  status: 409,
                });
              }
              isCreated = true;
              return new Response(JSON.stringify({ writeResults: [{}] }), { status: 200 });
            });
          })(),
        ),
      ),
    ),
  );

  it.effect(
    'writes a sweep at the revision it was read at, with its claim, last and stopped sweep',
    () =>
      Effect.gen(function* () {
        const store = yield* SweepStore;
        const sweep = {
          threshold: 5000,
          last: {
            sha: HEAD_SHA,
            at: DateTime.makeUnsafe('2026-01-02T00:00:00.000Z'),
            outcome: { _tag: 'Clean' as const },
            finishedBy: RUN_ID,
          },
          stopped: {
            at: DateTime.makeUnsafe('2026-01-03T00:00:00.000Z'),
            cause: 'Answer' as const,
          },
          carryOver: [{ file: 'src/a.ts', name: 'slowest' }],
          claim: {
            runId: RUN_ID,
            headSha: HEAD_SHA,
            claimedAt: DateTime.makeUnsafe(claimedAt),
          },
        };
        expect(
          yield* store.write({ projectId: '111', sweep, expectedRevision: Option.some('rev-1') }),
        ).toBe(true);
        expect(
          yield* store.write({ projectId: '111', sweep, expectedRevision: Option.some('rev-0') }),
        ).toBe(false);
      }).pipe(
        Effect.provide(
          withFirestore(
            scriptedFetch(async request => {
              if (request.url === METADATA_URL) return metadataToken();
              const body = (await request.json()) as {
                writes: [
                  {
                    update: { fields: Record<string, unknown> };
                    currentDocument: { updateTime: string };
                  },
                ];
              };
              const [write] = body.writes;
              expect(write.update.fields).toEqual({
                threshold: { integerValue: '5000' },
                carryOver: { stringValue: carryOverJson },
                last: {
                  stringValue: JSON.stringify({
                    sha: HEAD_SHA,
                    at: '2026-01-02T00:00:00.000Z',
                    outcome: { _tag: 'Clean' },
                    finishedBy: RUN_ID,
                  }),
                },
                stopped: { stringValue: stoppedJson },
                claim: { stringValue: claimJson },
              });
              if (write.currentDocument.updateTime === 'rev-1') {
                return new Response(JSON.stringify({ writeResults: [{}] }), { status: 200 });
              }
              return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), {
                status: 400,
              });
            }),
          ),
        ),
      ),
  );

  it.effect('dies on a read that is neither found nor answered', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      expect(Exit.hasDies(yield* Effect.exit(store.get('111')))).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            return new Response('{}', { status: 500 });
          }),
        ),
      ),
    ),
  );
});
