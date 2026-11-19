import { makeRoundId } from '@codetinder/api';
import { RoundSchema, VerdictsSchema } from '@codetinder/core';
import { describe, expect, it } from '@effect/vitest';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as TestClock from 'effect/testing/TestClock';
import { RoundStore, swipeDocId } from './round-store';
import { sampleAsk, sampleRound } from './test-fixtures';

/** `sampleAsk` as the store writes it in the round's `learn` field. */
const sampleAskJson = JSON.stringify({
  id: sampleAsk.id,
  swipes: sampleAsk.swipes,
  askedAt: '2026-01-05T00:00:00.000Z',
  isRetry: false,
  noteId: 900,
  startedAt: null,
  ended: null,
});

const METADATA_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const DOCUMENTS_URL =
  'https://firestore.googleapis.com/v1/projects/codetinder/databases/(default)/documents';

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
  Layer.mergeAll(RoundStore.firestore, Layer.succeed(FetchHttpClient.Fetch, fetch));

const DOCUMENT_NAME_PREFIX = 'projects/codetinder/databases/(default)/documents';
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const CLAIM_KEY = { projectId: '111', mergeRequestIid: 7, headSha: HEAD_SHA };
const CLAIM_ID = `111_7_${HEAD_SHA}`;
const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const roundId = makeRoundId(crypto.getRandomValues(new Uint8Array(12)));
const createdAt = DateTime.makeUnsafe('2026-01-01T00:00:00.000Z');
const roundJson = Effect.runSync(
  Schema.encodeEffect(Schema.fromJsonString(RoundSchema))(sampleRound),
);
const verdictsJson = Effect.runSync(
  Schema.encodeEffect(Schema.fromJsonString(VerdictsSchema))({ c1: 'like' }),
);
/** A fresh claim's fields, as Firestore holds them. */
const claimFields = {
  projectId: { stringValue: '111' },
  mergeRequestIid: { integerValue: '7' },
  headSha: { stringValue: HEAD_SHA },
  runId: { stringValue: RUN_ID },
  claimedAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
};
const otherRoundId = makeRoundId(new Uint8Array(12).fill(2));
/** The round as an older format stored it. */
const olderRoundJson = JSON.stringify({ ...JSON.parse(roundJson), version: 1 });

/** A rounds document as the REST API returns it, last written at `updateTime`. */
const roundDocument = (round: string, id = roundId, updateTime = '2026-01-01T00:00:00.000Z') => ({
  name: `projects/codetinder/databases/(default)/documents/rounds/${id}`,
  fields: {
    projectId: { stringValue: '111' },
    mergeRequestIid: { integerValue: '7' },
    round: { stringValue: round },
    createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
  },
  updateTime,
});

/** A `runQuery` body's `in` filter, as the tests read it back. */
type InQuery = {
  readonly where: {
    readonly fieldFilter: {
      readonly op: string;
      readonly value: { readonly arrayValue: { readonly values: readonly unknown[] } };
    };
  };
};

const metadataToken = (expiresIn = 3600) =>
  new Response(
    JSON.stringify({
      access_token: 'ya29.test',
      expires_in: expiresIn,
      token_type: 'Bearer',
    }),
    { status: 200 },
  );

describe('RoundStore.firestore', () => {
  it.effect("creates a round and records it on its commit's claim, at the claim's revision", () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const create = (expectedClaimRevision: string) =>
        store.create({
          round: {
            id: roundId,
            projectId: '111',
            mergeRequestIid: 7,
            headSha: HEAD_SHA,
            round: sampleRound,
            createdAt,
          },
          expectedClaimRevision,
        });
      expect(yield* create('rev-1')).toBe(true);
      expect(yield* create('rev-0')).toBe(false);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) {
              expect(request.headers.get('Metadata-Flavor')).toBe('Google');
              return metadataToken();
            }
            expect(request.method).toBe('POST');
            expect(request.url).toBe(`${DOCUMENTS_URL}:commit`);
            expect(request.headers.get('authorization')).toBe('Bearer ya29.test');
            const body = (await request.json()) as {
              writes: [unknown, { currentDocument: { updateTime: string } }];
            };
            const revision = body.writes[1].currentDocument.updateTime;
            expect(body).toEqual({
              writes: [
                {
                  update: {
                    name: `${DOCUMENT_NAME_PREFIX}/rounds/${roundId}`,
                    fields: {
                      projectId: { stringValue: '111' },
                      mergeRequestIid: { integerValue: '7' },
                      headSha: { stringValue: HEAD_SHA },
                      round: { stringValue: roundJson },
                      createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                    },
                  },
                  currentDocument: { exists: false },
                },
                {
                  update: {
                    name: `${DOCUMENT_NAME_PREFIX}/claims/${CLAIM_ID}`,
                    fields: { roundId: { stringValue: roundId } },
                  },
                  updateMask: { fieldPaths: ['roundId'] },
                  currentDocument: { updateTime: revision },
                },
              ],
            });
            if (revision === 'rev-1') {
              return new Response(JSON.stringify({ writeResults: [{}, {}] }), { status: 200 });
            }
            return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), {
              status: 400,
            });
          }),
        ),
      ),
    ),
  );

  it.effect('claims a commit for its run only while no claim exists on it', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const claim = {
        key: CLAIM_KEY,
        runId: RUN_ID,
        claimedAt: createdAt,
        askNoteId: Option.none(),
      };
      expect(yield* store.createClaim(claim)).toBe(true);
      expect(yield* store.createClaim(claim)).toBe(false);
    }).pipe(
      Effect.provide(
        withFirestore(
          (() => {
            let isClaimed = false;
            return scriptedFetch(async request => {
              if (request.url === METADATA_URL) return metadataToken();
              expect(request.method).toBe('POST');
              expect(request.url).toBe(`${DOCUMENTS_URL}/claims?documentId=${CLAIM_ID}`);
              expect(await request.json()).toEqual({ fields: claimFields });
              if (isClaimed) {
                return new Response(JSON.stringify({ error: { status: 'ALREADY_EXISTS' } }), {
                  status: 409,
                });
              }
              isClaimed = true;
              return new Response('{}', { status: 200 });
            });
          })(),
        ),
      ),
    ),
  );

  it.effect(
    'reads a claim, its run, its ask, its ending, its round and its revision, and none on miss',
    () =>
      Effect.gen(function* () {
        const store = yield* RoundStore;
        expect(yield* store.getClaim(CLAIM_KEY)).toEqual(
          Option.some({
            ...CLAIM_KEY,
            runId: RUN_ID,
            claimedAt: createdAt,
            askNoteId: Option.some(4242),
            endedAt: Option.some(DateTime.makeUnsafe('2026-01-01T00:05:00.000Z')),
            roundId: Option.some(roundId),
            revision: '2026-01-01T00:05:00.123456Z',
          }),
        );
        expect(yield* store.getClaim({ ...CLAIM_KEY, mergeRequestIid: 8 })).toEqual(Option.none());
      }).pipe(
        Effect.provide(
          withFirestore(
            scriptedFetch(request => {
              if (request.url === METADATA_URL) return metadataToken();
              if (request.url !== `${DOCUMENTS_URL}/claims/${CLAIM_ID}`) {
                return new Response('{}', { status: 404 });
              }
              return new Response(
                JSON.stringify({
                  name: `${DOCUMENT_NAME_PREFIX}/claims/${CLAIM_ID}`,
                  fields: {
                    ...claimFields,
                    askNoteId: { integerValue: '4242' },
                    endedAt: { timestampValue: '2026-01-01T00:05:00.000Z' },
                    roundId: { stringValue: roundId },
                  },
                  updateTime: '2026-01-01T00:05:00.123456Z',
                }),
                { status: 200 },
              );
            }),
          ),
        ),
      ),
  );

  it.effect('retakes a claim whole for a new run and its ask, only at the revision read', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const retake = (expectedRevision: string) =>
        store.retakeClaim({
          key: CLAIM_KEY,
          runId: RUN_ID,
          claimedAt: createdAt,
          askNoteId: Option.some(4242),
          expectedRevision,
        });
      expect(yield* retake('rev-1')).toBe(true);
      expect(yield* retake('rev-0')).toBe(false);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) return metadataToken();
            const url = new URL(request.url);
            expect(request.method).toBe('PATCH');
            expect(url.pathname).toBe(new URL(`${DOCUMENTS_URL}/claims/${CLAIM_ID}`).pathname);
            expect(url.searchParams.has('updateMask.fieldPaths')).toBe(false);
            expect(await request.json()).toEqual({
              fields: { ...claimFields, askNoteId: { integerValue: '4242' } },
            });
            if (url.searchParams.get('currentDocument.updateTime') === 'rev-1') {
              return new Response('{}', { status: 200 });
            }
            return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), {
              status: 400,
            });
          }),
        ),
      ),
    ),
  );

  it.effect('ends a claim only at the revision it was read at', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const endedAt = DateTime.makeUnsafe('2026-01-01T00:05:00.000Z');
      const end = (expectedRevision: string) =>
        store.endClaim({ key: CLAIM_KEY, endedAt, expectedRevision });
      expect(yield* end('rev-1')).toBe(true);
      expect(yield* end('rev-0')).toBe(false);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) return metadataToken();
            const url = new URL(request.url);
            expect(request.method).toBe('PATCH');
            expect(url.pathname.endsWith(`/claims/${CLAIM_ID}`)).toBe(true);
            expect(url.searchParams.get('updateMask.fieldPaths')).toBe('endedAt');
            expect(await request.json()).toEqual({
              fields: { endedAt: { timestampValue: '2026-01-01T00:05:00.000Z' } },
            });
            if (url.searchParams.get('currentDocument.updateTime') === 'rev-1') {
              return new Response('{}', { status: 200 });
            }
            return new Response(JSON.stringify({ error: { status: 'FAILED_PRECONDITION' } }), {
              status: 400,
            });
          }),
        ),
      ),
    ),
  );

  it.effect('gets a round on hit and none on miss', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const hit = yield* store.get(roundId);
      expect(Option.isSome(hit)).toBe(true);
      if (Option.isSome(hit)) {
        expect(hit.value.projectId).toBe('111');
        expect(hit.value.mergeRequestIid).toBe(7);
        expect(hit.value.round.target.file).toBe('src/f.ts');
      }
      const miss = yield* store.get(makeRoundId(new Uint8Array(12).fill(1)));
      expect(Option.isNone(miss)).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.url === `${DOCUMENTS_URL}/rounds/${roundId}`) {
              return new Response(
                JSON.stringify({
                  name: `projects/codetinder/databases/(default)/documents/rounds/${roundId}`,
                  fields: {
                    projectId: { stringValue: '111' },
                    mergeRequestIid: { integerValue: '7' },
                    round: { stringValue: roundJson },
                    createdAt: { timestampValue: '2026-01-01T00:00:00.000Z' },
                  },
                  updateTime: '2026-01-01T00:00:00.000Z',
                }),
                { status: 200 },
              );
            }
            return new Response('{}', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('upserts swipes and decodes runQuery', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const updatedAt = DateTime.makeUnsafe('2026-01-02T00:00:00.000Z');
      yield* store.putSwipes({
        roundId,
        projectId: '111',
        userId: 42,
        username: 'ada',
        verdicts: { c1: 'like' },
        updatedAt,
      });
      const swipes = yield* store.listSwipes([roundId]);
      expect(swipes.get(roundId)).toEqual([
        expect.objectContaining({
          userId: 42,
          username: 'ada',
          verdicts: { c1: 'like' },
        }),
      ]);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.method === 'PATCH') {
              expect(request.url).toBe(
                `${DOCUMENTS_URL}/swipes/${encodeURIComponent(swipeDocId(roundId, 42))}`,
              );
              return new Response('{}', { status: 200 });
            }
            if (request.url === `${DOCUMENTS_URL}:runQuery`) {
              return new Response(
                JSON.stringify([
                  {
                    document: {
                      name: `projects/codetinder/databases/(default)/documents/swipes/${swipeDocId(roundId, 42)}`,
                      fields: {
                        roundId: { stringValue: roundId },
                        projectId: { stringValue: '111' },
                        userId: { integerValue: '42' },
                        username: { stringValue: 'ada' },
                        verdicts: { stringValue: verdictsJson },
                        updatedAt: { timestampValue: '2026-01-02T00:00:00.000Z' },
                      },
                    },
                    readTime: '2026-01-02T00:00:00.000Z',
                  },
                  { readTime: '2026-01-02T00:00:00.000Z' },
                ]),
                { status: 200 },
              );
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    ),
  );

  it.effect('refreshes the metadata token after expiry under TestClock', () => {
    const tokenCalls: string[] = [];
    return Effect.gen(function* () {
      const store = yield* RoundStore;
      yield* store.get(roundId);
      // expires_in 3600; refresh 60 s before → after 3540 s the cache entry is stale
      yield* TestClock.adjust('3540 seconds');
      yield* store.get(roundId);
      expect(tokenCalls).toHaveLength(2);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) {
              tokenCalls.push('token');
              return metadataToken(3600);
            }
            return new Response('{}', { status: 404 });
          }),
        ),
      ),
    );
  });

  it.effect('gives up on a Firestore call that does not answer within 10 seconds', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const fiber = yield* Effect.forkChild(Effect.exit(store.get(roundId)));
      yield* TestClock.adjust('10 seconds');
      expect(Exit.hasDies(yield* Fiber.join(fiber))).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            return new Promise<Response>(() => {});
          }),
        ),
      ),
    ),
  );

  it.effect('does not find a round of an older format', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      expect(Option.isNone(yield* store.get(roundId))).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.url === `${DOCUMENTS_URL}/rounds/${roundId}`) {
              return Response.json(roundDocument(olderRoundJson));
            }
            return new Response('{}', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('lists rounds newest first and leaves out an older format', () => {
    const queries: unknown[] = [];
    return Effect.gen(function* () {
      const store = yield* RoundStore;
      const listed = yield* store.listRounds('111', 50);
      expect(listed.map(({ id }) => id)).toEqual([roundId]);
      expect(queries).toEqual([
        {
          structuredQuery: {
            from: [{ collectionId: 'rounds' }],
            where: {
              fieldFilter: {
                field: { fieldPath: 'projectId' },
                op: 'EQUAL',
                value: { stringValue: '111' },
              },
            },
            orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
            limit: 50,
          },
        },
      ]);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.url === `${DOCUMENTS_URL}:runQuery`) {
              queries.push(await request.json());
              return Response.json([
                { document: roundDocument(roundJson) },
                { document: roundDocument(olderRoundJson, otherRoundId) },
                { readTime: '2026-01-01T00:00:00.000Z' },
              ]);
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    );
  });

  it.effect('asks for swipes of at most 30 rounds at a time, none for no rounds', () => {
    const queries: { structuredQuery: InQuery }[] = [];
    const ids = Array.from({ length: 31 }, (_, index) =>
      makeRoundId(new Uint8Array(12).fill(index)),
    );
    return Effect.gen(function* () {
      const store = yield* RoundStore;
      expect((yield* store.listSwipes([])).size).toBe(0);
      expect(queries).toHaveLength(0);

      expect((yield* store.listSwipes(ids)).size).toBe(0);
      expect(queries.map(({ structuredQuery }) => structuredQuery.where.fieldFilter.op)).toEqual([
        'IN',
        'IN',
      ]);
      expect(
        queries.map(
          ({ structuredQuery }) => structuredQuery.where.fieldFilter.value.arrayValue.values.length,
        ),
      ).toEqual([30, 1]);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.url === `${DOCUMENTS_URL}:runQuery`) {
              queries.push((await request.json()) as { structuredQuery: InQuery });
              return Response.json([{ readTime: '2026-01-01T00:00:00.000Z' }]);
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    );
  });

  it.effect("reads the round's ask, and the revision the round was read at", () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const stored = Option.getOrThrow(yield* store.get(roundId));
      expect(stored.learn).toEqual(Option.some(sampleAsk));
      expect(stored.revision).toBe('2026-01-05T00:00:00.000Z');
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.url === `${DOCUMENTS_URL}/rounds/${roundId}`) {
              const document = roundDocument(roundJson);
              return Response.json({
                ...document,
                fields: { ...document.fields, learn: { stringValue: sampleAskJson } },
                updateTime: '2026-01-05T00:00:00.000Z',
              });
            }
            return new Response('{}', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('writes an ask with the revision it was read at as the precondition', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const written = yield* store.writeLearn({
        roundId,
        learn: sampleAsk,
        expectedRevision: '2026-01-05T00:00:00.000Z',
      });
      expect(written).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(async request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.method === 'PATCH') {
              const url = new URL(request.url);
              expect(url.pathname.endsWith(`/rounds/${roundId}`)).toBe(true);
              expect(url.searchParams.getAll('updateMask.fieldPaths')).toEqual(['learn']);
              expect(await request.json()).toEqual({
                fields: { learn: { stringValue: sampleAskJson } },
              });
              expect(url.searchParams.get('currentDocument.updateTime')).toBe(
                '2026-01-05T00:00:00.000Z',
              );
              return Response.json(roundDocument(roundJson));
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    ),
  );

  it.effect('refuses an ask when the round changed since it was read', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const written = yield* store.writeLearn({
        roundId,
        learn: sampleAsk,
        expectedRevision: '2026-01-04T00:00:00.000Z',
      });
      expect(written).toBe(false);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.method === 'PATCH') {
              return Response.json(
                {
                  error: {
                    code: 400,
                    message: 'The document has changed.',
                    status: 'FAILED_PRECONDITION',
                  },
                },
                { status: 400 },
              );
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    ),
  );

  it.effect('gives up on an ask answered with any other error', () =>
    Effect.gen(function* () {
      const store = yield* RoundStore;
      const exit = yield* Effect.exit(
        store.writeLearn({
          roundId,
          learn: sampleAsk,
          expectedRevision: '2026-01-04T00:00:00.000Z',
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withFirestore(
          scriptedFetch(request => {
            if (request.url === METADATA_URL) return metadataToken();
            if (request.method === 'PATCH') {
              return Response.json(
                { error: { code: 400, message: 'bad', status: 'INVALID_ARGUMENT' } },
                { status: 400 },
              );
            }
            return new Response('unexpected', { status: 500 });
          }),
        ),
      ),
    ),
  );
});
