import { type DeveloperSwipes, RoundIdSchema } from '@codetinder/api';
import { RoundSchema, VerdictsSchema } from '@codetinder/core';
import * as Arr from 'effect/Array';
import * as Context from 'effect/Context';
import * as DateTime from 'effect/DateTime';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Ref from 'effect/Ref';
import * as Schema from 'effect/Schema';
import {
  errorStatus,
  FirestoreErrorSchema,
  firestoreConnection,
  IntegerValueSchema,
  StringValueSchema,
  TimestampValueSchema,
  unexpectedStatus,
} from './firestore';
import { type LearnAsk, LearnAskSchema } from './learn';

/** Firestore's `in` takes at most this many values. */
const IN_MAX_VALUES = 30;

/** One commit of a merge request: CodeTinder makes at most one round for it. */
export type CommitKey = {
  readonly projectId: string;
  readonly mergeRequestIid: number;
  readonly headSha: string;
};

/** A run's claim on making a commit's round, held by the run that made it. */
export type NewClaim = {
  readonly key: CommitKey;
  readonly runId: string;
  readonly claimedAt: DateTime.Utc;
  /** The developer's ask that started the run, when one did: its note. */
  readonly askNoteId: Option.Option<number>;
};

export type Claim = CommitKey & {
  /** The run that holds it: only its round and its end apply. */
  readonly runId: string;
  readonly claimedAt: DateTime.Utc;
  /** The note of the developer's ask that the holding run answers, when one started it. */
  readonly askNoteId: Option.Option<number>;
  /** When the run that claimed it ended without a round. */
  readonly endedAt: Option.Option<DateTime.Utc>;
  readonly roundId: Option.Option<typeof RoundIdSchema.Type>;
  /** Changes with every write to the claim, so a write can refuse a claim read before a change. */
  readonly revision: string;
};

export type NewRound = {
  readonly id: typeof RoundIdSchema.Type;
  readonly projectId: string;
  readonly mergeRequestIid: number;
  /** The commit the round was made at. */
  readonly headSha: string;
  readonly round: typeof RoundSchema.Type;
  readonly createdAt: DateTime.Utc;
};

// The head is recorded, not read back: rounds stored before it was recorded have none.
export type StoredRound = Omit<NewRound, 'headSha'> & {
  /** The latest Done's ask to learn the swipes, and how its run went; none before any Done. */
  readonly learn: Option.Option<LearnAsk>;
  /** Changes with every write to the round, so a write can refuse a round read before a change. */
  readonly revision: string;
};

export type WriteLearnInput = {
  readonly roundId: typeof RoundIdSchema.Type;
  readonly learn: LearnAsk;
  readonly expectedRevision: string;
};

export type PutSwipesInput = {
  readonly roundId: typeof RoundIdSchema.Type;
  readonly projectId: string;
  readonly userId: number;
  readonly username: string;
  readonly verdicts: typeof VerdictsSchema.Type;
  readonly updatedAt: DateTime.Utc;
};

export class RoundStore extends Context.Service<
  RoundStore,
  {
    /**
     * Stores a round and records it on its commit's claim, in one write made only while the claim
     * is at `expectedClaimRevision`. False, and nothing written, when the claim changed since.
     */
    readonly create: (input: {
      readonly round: NewRound;
      readonly expectedClaimRevision: string;
    }) => Effect.Effect<boolean>;
    /** None when there is no such round, or it is in an older format: that doesn't decode. */
    readonly get: (id: typeof RoundIdSchema.Type) => Effect.Effect<Option.Option<StoredRound>>;
    /** A project's newest rounds of the current format, newest first. */
    readonly listRounds: (
      projectId: string,
      limit: number,
    ) => Effect.Effect<readonly StoredRound[]>;
    /**
     * Writes the round's latest ask. False, and nothing written, when the round changed since
     * `expectedRevision` was read: another write about its ask landed first.
     */
    readonly writeLearn: (input: WriteLearnInput) => Effect.Effect<boolean>;
    readonly putSwipes: (input: PutSwipesInput) => Effect.Effect<void>;
    /** The swipes of each round asked for, keyed by round id; a round nobody swiped has none. */
    readonly listSwipes: (
      roundIds: readonly (typeof RoundIdSchema.Type)[],
    ) => Effect.Effect<ReadonlyMap<string, readonly DeveloperSwipes[]>>;
    readonly getClaim: (key: CommitKey) => Effect.Effect<Option.Option<Claim>>;
    /** Claims a commit no run has claimed. False, and nothing written, when one has. */
    readonly createClaim: (claim: NewClaim) => Effect.Effect<boolean>;
    /**
     * Gives a commit to a new run, forgetting how the last attempt ended. False, and nothing
     * written, when the claim changed since `expectedRevision` was read.
     */
    readonly retakeClaim: (
      claim: NewClaim & { readonly expectedRevision: string },
    ) => Effect.Effect<boolean>;
    /**
     * Records that the claim's run ended without a round. False, and nothing written, when the
     * claim changed since `expectedRevision` was read.
     */
    readonly endClaim: (input: {
      readonly key: CommitKey;
      readonly endedAt: DateTime.Utc;
      readonly expectedRevision: string;
    }) => Effect.Effect<boolean>;
  }
>()('@codetinder/server/RoundStore') {
  static readonly memory = Layer.effect(
    RoundStore,
    Effect.gen(function* () {
      const rounds = yield* Ref.make(new Map<string, StoredRound>());
      const swipes = yield* Ref.make(
        new Map<string, DeveloperSwipes & { readonly roundId: string }>(),
      );
      const claims = yield* Ref.make(new Map<string, Claim>());

      // Uninterruptible, so both writes land or neither, as Firestore's commit: a claim never
      // names a round that wasn't stored.
      const create = Effect.fn('RoundStore.create')(function* ({
        round,
        expectedClaimRevision,
      }: {
        readonly round: NewRound;
        readonly expectedClaimRevision: string;
      }) {
        const key = claimDocId(round);
        const isRecorded = yield* Ref.modify(claims, map => {
          const claim = map.get(key);
          if (claim?.revision !== expectedClaimRevision) return [false, map] as const;
          const recorded: Claim = {
            ...claim,
            roundId: Option.some(round.id),
            revision: crypto.randomUUID(),
          };
          return [true, new Map(map).set(key, recorded)] as const;
        });
        if (!isRecorded) return false;
        const stored: StoredRound = {
          ...round,
          learn: Option.none(),
          revision: crypto.randomUUID(),
        };
        yield* Ref.update(rounds, map => new Map(map).set(round.id, stored));
        return true;
      }, Effect.uninterruptible);

      const get = Effect.fn('RoundStore.get')(function* (id: typeof RoundIdSchema.Type) {
        const map = yield* Ref.get(rounds);
        return Option.fromNullishOr(map.get(id));
      });

      const listRounds = Effect.fn('RoundStore.listRounds')(function* (
        projectId: string,
        limit: number,
      ) {
        const map = yield* Ref.get(rounds);
        return [...map.values()]
          .filter(round => round.projectId === projectId)
          .sort((a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt))
          .slice(0, limit);
      });

      const writeLearn = Effect.fn('RoundStore.writeLearn')(function* (input: WriteLearnInput) {
        return yield* Ref.modify(rounds, map => {
          const stored = map.get(input.roundId);
          if (stored === undefined || stored.revision !== input.expectedRevision) {
            return [false, map] as const;
          }
          const updated: StoredRound = {
            ...stored,
            learn: Option.some(input.learn),
            revision: crypto.randomUUID(),
          };
          return [true, new Map(map).set(input.roundId, updated)] as const;
        });
      });

      const putSwipes = Effect.fn('RoundStore.putSwipes')(function* (input: PutSwipesInput) {
        const key = swipeDocId(input.roundId, input.userId);
        const entry = {
          roundId: input.roundId,
          userId: input.userId,
          username: input.username,
          verdicts: input.verdicts,
          updatedAt: input.updatedAt,
        };
        yield* Ref.update(swipes, map => new Map(map).set(key, entry));
      });

      const listSwipes = Effect.fn('RoundStore.listSwipes')(function* (
        roundIds: readonly (typeof RoundIdSchema.Type)[],
      ) {
        const map = yield* Ref.get(swipes);
        const wanted = new Set<string>(roundIds);
        const entries = [...map.values()].filter(({ roundId }) => wanted.has(roundId));
        return new Map(
          [...Map.groupBy(entries, ({ roundId }) => roundId)].map(
            ([roundId, group]): [string, DeveloperSwipes[]] => [
              roundId,
              group.map(({ userId, username, verdicts, updatedAt }) => ({
                userId,
                username,
                verdicts,
                updatedAt,
              })),
            ],
          ),
        );
      });

      const getClaim = Effect.fn('RoundStore.getClaim')(function* (key: CommitKey) {
        return Option.fromNullishOr((yield* Ref.get(claims)).get(claimDocId(key)));
      });

      const newClaim = ({ key, runId, claimedAt, askNoteId }: NewClaim): Claim => ({
        ...key,
        runId,
        claimedAt,
        askNoteId,
        endedAt: Option.none(),
        roundId: Option.none(),
        revision: crypto.randomUUID(),
      });

      const createClaim = Effect.fn('RoundStore.createClaim')(function* (claim: NewClaim) {
        return yield* Ref.modify(claims, map => {
          if (map.has(claimDocId(claim.key))) return [false, map] as const;
          return [true, new Map(map).set(claimDocId(claim.key), newClaim(claim))] as const;
        });
      });

      const retakeClaim = Effect.fn('RoundStore.retakeClaim')(function* ({
        expectedRevision,
        ...claim
      }: NewClaim & { readonly expectedRevision: string }) {
        return yield* Ref.modify(claims, map => {
          const id = claimDocId(claim.key);
          if (map.get(id)?.revision !== expectedRevision) return [false, map] as const;
          return [true, new Map(map).set(id, newClaim(claim))] as const;
        });
      });

      const endClaim = Effect.fn('RoundStore.endClaim')(function* ({
        key,
        endedAt,
        expectedRevision,
      }: {
        readonly key: CommitKey;
        readonly endedAt: DateTime.Utc;
        readonly expectedRevision: string;
      }) {
        return yield* Ref.modify(claims, map => {
          const claim = map.get(claimDocId(key));
          if (claim === undefined || claim.revision !== expectedRevision) {
            return [false, map] as const;
          }
          const ended: Claim = {
            ...claim,
            endedAt: Option.some(endedAt),
            revision: crypto.randomUUID(),
          };
          return [true, new Map(map).set(claimDocId(key), ended)] as const;
        });
      });

      return RoundStore.of({
        create,
        get,
        listRounds,
        writeLearn,
        putSwipes,
        listSwipes,
        getClaim,
        createClaim,
        retakeClaim,
        endClaim,
      });
    }),
  );

  static readonly firestore = Layer.effect(
    RoundStore,
    Effect.gen(function* () {
      const { documentsUrl, documentName, execute } = yield* firestoreConnection;

      /** Firestore answering outside 2xx is a fault. */
      const executeOk = Effect.fn('RoundStore.executeOk')(function* (
        request: HttpClientRequest.HttpClientRequest,
      ) {
        const response = yield* execute(request);
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.die(
            new Error(`Firestore ${request.method} ${request.url}: status ${response.status}`),
          );
        }
        return response;
      });

      /**
       * The documents a structured query finds, each decoded as `document`. runQuery answers an
       * array of rows, one per document plus a trailing row that has only the read time:
       * https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/runQuery
       */
      const runQuery = <S extends Schema.Top>(document: S, structuredQuery: object) =>
        Effect.gen(function* () {
          const response = yield* executeOk(
            HttpClientRequest.post(`${documentsUrl}:runQuery`).pipe(
              HttpClientRequest.bodyJsonUnsafe({ structuredQuery }),
            ),
          );
          const rows = yield* HttpClientResponse.schemaBodyJson(RunQueryResponseSchema)(
            response,
          ).pipe(Effect.orDie);
          return yield* Effect.forEach(
            rows.flatMap(row => (row.document === undefined ? [] : [row.document])),
            found => Schema.decodeUnknownEffect(document)(found).pipe(Effect.orDie),
            { concurrency: 1 },
          );
        });

      /**
       * The round and its commit's claim in one atomic commit: the round only if its id is new,
       * its id on the claim only while the claim is at the revision read, so of two writes from
       * one claim only the first lands. Firestore refuses the commit with FAILED_PRECONDITION.
       * https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/commit
       */
      const create = Effect.fn('RoundStore.create')(function* ({
        round,
        expectedClaimRevision,
      }: {
        readonly round: NewRound;
        readonly expectedClaimRevision: string;
      }) {
        const roundJson = yield* Schema.encodeEffect(Schema.fromJsonString(RoundSchema))(
          round.round,
        ).pipe(Effect.orDie);
        const writes = [
          {
            update: {
              name: documentName(`rounds/${round.id}`),
              fields: {
                projectId: { stringValue: round.projectId },
                mergeRequestIid: { integerValue: String(round.mergeRequestIid) },
                headSha: { stringValue: round.headSha },
                round: { stringValue: roundJson },
                createdAt: { timestampValue: DateTime.formatIso(round.createdAt) },
              },
            },
            currentDocument: { exists: false },
          },
          {
            update: {
              name: documentName(`claims/${claimDocId(round)}`),
              fields: { roundId: { stringValue: round.id } },
            },
            updateMask: { fieldPaths: ['roundId'] },
            currentDocument: { updateTime: expectedClaimRevision },
          },
        ];
        const request = HttpClientRequest.post(`${documentsUrl}:commit`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ writes }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        if (response.status === 400 && (yield* errorStatus(response)) === 'FAILED_PRECONDITION') {
          return false;
        }
        return yield* unexpectedStatus(request, response);
      });

      const get = Effect.fn('RoundStore.get')(function* (id: typeof RoundIdSchema.Type) {
        const request = HttpClientRequest.get(`${documentsUrl}/rounds/${id}`);
        const response = yield* execute(request);
        if (response.status === 404) return Option.none();
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`Firestore ${request.method} ${request.url}: status ${response.status}`),
          );
        }
        const document = yield* HttpClientResponse.schemaBodyJson(RoundDocumentSchema)(
          response,
        ).pipe(Effect.orDie);
        return yield* decodeStoredRound(id, document);
      });

      // Equality on projectId with an order on createdAt needs the composite index declared in
      // apps/server/firestore.indexes.json.
      const listRounds = Effect.fn('RoundStore.listRounds')(function* (
        projectId: string,
        limit: number,
      ) {
        const documents = yield* runQuery(RoundDocumentSchema, {
          from: [{ collectionId: 'rounds' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'projectId' },
              op: 'EQUAL',
              value: { stringValue: projectId },
            },
          },
          orderBy: [{ field: { fieldPath: 'createdAt' }, direction: 'DESCENDING' }],
          limit,
        });
        const rounds = yield* Effect.forEach(
          documents,
          document =>
            roundIdOf(document.name).pipe(Effect.flatMap(id => decodeStoredRound(id, document))),
          { concurrency: 1 },
        );
        return rounds.flatMap(round => (Option.isSome(round) ? [round.value] : []));
      });

      /**
       * A PATCH with `currentDocument.updateTime` writes only if the round is still at the revision
       * read. Firestore answers a precondition that fails with FAILED_PRECONDITION (400):
       * https://cloud.google.com/apis/design/errors#http_mapping
       */
      const writeLearn = Effect.fn('RoundStore.writeLearn')(function* (input: WriteLearnInput) {
        const learn = yield* Schema.encodeEffect(LearnAskJsonSchema)(input.learn).pipe(
          Effect.orDie,
        );
        const request = HttpClientRequest.patch(`${documentsUrl}/rounds/${input.roundId}`).pipe(
          HttpClientRequest.setUrlParams({
            'updateMask.fieldPaths': 'learn',
            'currentDocument.updateTime': input.expectedRevision,
          }),
          HttpClientRequest.bodyJsonUnsafe({ fields: { learn: { stringValue: learn } } }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        const error = yield* HttpClientResponse.schemaBodyJson(FirestoreErrorSchema)(response).pipe(
          Effect.orDie,
        );
        if (response.status === 400 && error.error.status === 'FAILED_PRECONDITION') return false;
        return yield* Effect.die(
          new Error(`Firestore ${request.method} ${request.url}: status ${response.status}`),
        );
      });

      const putSwipes = Effect.fn('RoundStore.putSwipes')(function* (input: PutSwipesInput) {
        const verdictsJson = yield* Schema.encodeEffect(Schema.fromJsonString(VerdictsSchema))(
          input.verdicts,
        ).pipe(Effect.orDie);
        const docId = swipeDocId(input.roundId, input.userId);
        const body = {
          fields: {
            roundId: { stringValue: input.roundId },
            projectId: { stringValue: input.projectId },
            userId: { integerValue: String(input.userId) },
            username: { stringValue: input.username },
            verdicts: { stringValue: verdictsJson },
            updatedAt: { timestampValue: DateTime.formatIso(input.updatedAt) },
          },
        };
        // PATCH upserts when the document is missing (no currentDocument precondition):
        // https://firebase.google.com/docs/firestore/reference/rest/v1/projects.databases.documents/patch
        yield* executeOk(
          HttpClientRequest.patch(`${documentsUrl}/swipes/${encodeURIComponent(docId)}`).pipe(
            HttpClientRequest.bodyJsonUnsafe(body),
          ),
        );
      });

      const listSwipes = Effect.fn('RoundStore.listSwipes')(function* (
        roundIds: readonly (typeof RoundIdSchema.Type)[],
      ) {
        const documents = yield* Effect.forEach(
          Arr.chunksOf(roundIds, IN_MAX_VALUES),
          chunk =>
            runQuery(SwipeDocumentSchema, {
              from: [{ collectionId: 'swipes' }],
              where: {
                fieldFilter: {
                  field: { fieldPath: 'roundId' },
                  op: 'IN',
                  value: { arrayValue: { values: chunk.map(id => ({ stringValue: id })) } },
                },
              },
            }),
          { concurrency: 1 },
        );
        const swipes = yield* Effect.forEach(
          documents.flat(),
          document =>
            decodeDeveloperSwipes(document.fields).pipe(
              Effect.map(swipe => ({ roundId: document.fields.roundId.stringValue, swipe })),
            ),
          { concurrency: 1 },
        );
        return new Map(
          [...Map.groupBy(swipes, ({ roundId }) => roundId)].map(
            ([roundId, group]): [string, DeveloperSwipes[]] => [
              roundId,
              group.map(({ swipe }) => swipe),
            ],
          ),
        );
      });

      const getClaim = Effect.fn('RoundStore.getClaim')(function* (key: CommitKey) {
        const request = HttpClientRequest.get(`${documentsUrl}/claims/${claimDocId(key)}`);
        const response = yield* execute(request);
        if (response.status === 404) return Option.none();
        if (response.status !== 200) return yield* unexpectedStatus(request, response);
        const document = yield* HttpClientResponse.schemaBodyJson(ClaimDocumentSchema)(
          response,
        ).pipe(Effect.orDie);
        return Option.some(yield* decodeClaim(key, document));
      });

      /**
       * Create-if-absent: creating a document whose id is taken is refused with ALREADY_EXISTS
       * (409), so of two runs racing on one commit exactly one gets the claim.
       */
      const createClaim = Effect.fn('RoundStore.createClaim')(function* (claim: NewClaim) {
        const request = HttpClientRequest.post(`${documentsUrl}/claims`).pipe(
          HttpClientRequest.setUrlParams({ documentId: claimDocId(claim.key) }),
          HttpClientRequest.bodyJsonUnsafe({ fields: claimFields(claim) }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        if (response.status === 409 && (yield* errorStatus(response)) === 'ALREADY_EXISTS') {
          return false;
        }
        return yield* unexpectedStatus(request, response);
      });

      // A PATCH with no update mask replaces the whole document: the ending and round go.
      const retakeClaim = Effect.fn('RoundStore.retakeClaim')(function* ({
        expectedRevision,
        ...claim
      }: NewClaim & { readonly expectedRevision: string }) {
        const request = HttpClientRequest.patch(
          `${documentsUrl}/claims/${claimDocId(claim.key)}`,
        ).pipe(
          HttpClientRequest.setUrlParams({ 'currentDocument.updateTime': expectedRevision }),
          HttpClientRequest.bodyJsonUnsafe({ fields: claimFields(claim) }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        if (response.status === 400 && (yield* errorStatus(response)) === 'FAILED_PRECONDITION') {
          return false;
        }
        return yield* unexpectedStatus(request, response);
      });

      // Preconditioned on the revision read, so an end can't land on a claim another run retook.
      const endClaim = Effect.fn('RoundStore.endClaim')(function* ({
        key,
        endedAt,
        expectedRevision,
      }: {
        readonly key: CommitKey;
        readonly endedAt: DateTime.Utc;
        readonly expectedRevision: string;
      }) {
        const request = HttpClientRequest.patch(`${documentsUrl}/claims/${claimDocId(key)}`).pipe(
          HttpClientRequest.setUrlParams({
            'updateMask.fieldPaths': 'endedAt',
            'currentDocument.updateTime': expectedRevision,
          }),
          HttpClientRequest.bodyJsonUnsafe({
            fields: { endedAt: { timestampValue: DateTime.formatIso(endedAt) } },
          }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        if (response.status === 400 && (yield* errorStatus(response)) === 'FAILED_PRECONDITION') {
          return false;
        }
        return yield* unexpectedStatus(request, response);
      });

      return RoundStore.of({
        create,
        get,
        listRounds,
        writeLearn,
        putSwipes,
        listSwipes,
        getClaim,
        createClaim,
        retakeClaim,
        endClaim,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

export const swipeDocId = (roundId: string, userId: number): string => `${roundId}_${userId}`;

export const claimDocId = ({ projectId, mergeRequestIid, headSha }: CommitKey): string =>
  `${projectId}_${mergeRequestIid}_${headSha}`;

const RoundFieldsSchema = Schema.Struct({
  projectId: StringValueSchema,
  mergeRequestIid: IntegerValueSchema,
  round: StringValueSchema,
  createdAt: TimestampValueSchema,
  // Absent until a Done has been recorded.
  learn: Schema.optionalKey(StringValueSchema),
});

const LearnAskJsonSchema = Schema.fromJsonString(Schema.toCodecJson(LearnAskSchema));

const ClaimDocumentSchema = Schema.Struct({
  fields: Schema.Struct({
    runId: StringValueSchema,
    claimedAt: TimestampValueSchema,
    // Absent while the claiming run goes on.
    endedAt: Schema.optionalKey(TimestampValueSchema),
    // Absent until the commit's round is stored.
    roundId: Schema.optionalKey(StringValueSchema),
    // Absent when no developer's ask started the holding run.
    askNoteId: Schema.optionalKey(IntegerValueSchema),
  }),
  updateTime: Schema.String,
});

/** A claim's fields as a fresh claim writes them. */
const claimFields = ({ key, runId, claimedAt, askNoteId }: NewClaim) => ({
  projectId: { stringValue: key.projectId },
  mergeRequestIid: { integerValue: String(key.mergeRequestIid) },
  headSha: { stringValue: key.headSha },
  runId: { stringValue: runId },
  claimedAt: { timestampValue: DateTime.formatIso(claimedAt) },
  ...(Option.isSome(askNoteId) ? { askNoteId: { integerValue: String(askNoteId.value) } } : {}),
});

const SwipeFieldsSchema = Schema.Struct({
  roundId: StringValueSchema,
  projectId: StringValueSchema,
  userId: IntegerValueSchema,
  username: StringValueSchema,
  verdicts: StringValueSchema,
  updatedAt: TimestampValueSchema,
});

const RoundDocumentSchema = Schema.Struct({
  name: Schema.String,
  fields: RoundFieldsSchema,
  updateTime: Schema.String,
});

const SwipeDocumentSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  fields: SwipeFieldsSchema,
});

/** Each row of a runQuery answer; the rows' documents are decoded by the query that asked. */
const RunQueryResponseSchema = Schema.Array(
  Schema.Struct({ document: Schema.optionalKey(Schema.Unknown) }),
);

/** The round id a document's name ends in: `projects/…/documents/rounds/<id>`. */
const roundIdOf = (name: string) =>
  Schema.decodeEffect(RoundIdSchema)(name.slice(name.lastIndexOf('/') + 1)).pipe(Effect.orDie);

/**
 * A stored round in the current format, or none when it doesn't decode: a round of an older format
 * is not found, so its link shows not-found.
 */
const decodeStoredRound = (
  id: typeof RoundIdSchema.Type,
  document: typeof RoundDocumentSchema.Type,
): Effect.Effect<Option.Option<StoredRound>> =>
  Effect.gen(function* () {
    const { fields } = document;
    const round = yield* Schema.decodeEffect(Schema.fromJsonString(RoundSchema))(
      fields.round.stringValue,
    ).pipe(Effect.option);
    if (Option.isNone(round)) return Option.none();
    const createdAt = yield* decodeTimestamp(fields.createdAt.timestampValue);
    const learn =
      fields.learn === undefined
        ? Option.none()
        : Option.some(
            yield* Schema.decodeEffect(LearnAskJsonSchema)(fields.learn.stringValue).pipe(
              Effect.orDie,
            ),
          );
    return Option.some({
      id,
      projectId: fields.projectId.stringValue,
      mergeRequestIid: Number(fields.mergeRequestIid.integerValue),
      round: round.value,
      createdAt,
      learn,
      revision: document.updateTime,
    });
  });

const decodeClaim = (
  key: CommitKey,
  { fields, updateTime }: typeof ClaimDocumentSchema.Type,
): Effect.Effect<Claim> =>
  Effect.gen(function* () {
    const endedAt = fields.endedAt?.timestampValue;
    const roundId = fields.roundId?.stringValue;
    return {
      ...key,
      runId: fields.runId.stringValue,
      claimedAt: yield* decodeTimestamp(fields.claimedAt.timestampValue),
      askNoteId: Option.map(Option.fromNullishOr(fields.askNoteId?.integerValue), Number),
      endedAt: endedAt === undefined ? Option.none() : Option.some(yield* decodeTimestamp(endedAt)),
      roundId:
        roundId === undefined
          ? Option.none()
          : Option.some(yield* Schema.decodeEffect(RoundIdSchema)(roundId).pipe(Effect.orDie)),
      revision: updateTime,
    };
  });

const decodeDeveloperSwipes = (
  fields: typeof SwipeFieldsSchema.Type,
): Effect.Effect<DeveloperSwipes> =>
  Effect.gen(function* () {
    const verdicts = yield* Schema.decodeEffect(Schema.fromJsonString(VerdictsSchema))(
      fields.verdicts.stringValue,
    ).pipe(Effect.orDie);
    const updatedAt = yield* decodeTimestamp(fields.updatedAt.timestampValue);
    return {
      userId: Number(fields.userId.integerValue),
      username: fields.username.stringValue,
      verdicts,
      updatedAt,
    };
  });

const decodeTimestamp = (value: string): Effect.Effect<DateTime.Utc> =>
  Schema.decodeEffect(Schema.DateTimeUtcFromString)(value).pipe(Effect.orDie);
