import {
  CommitShaSchema,
  LastSweepSchema,
  RunIdSchema,
  type StoppedSweep,
  StoppedSweepSchema,
  type SweepFunction,
  SweepFunctionSchema,
  SweepThresholdSchema,
} from '@codetinder/api';
import * as Context from 'effect/Context';
import type * as DateTime from 'effect/DateTime';
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
  firestoreConnection,
  IntegerValueSchema,
  StringValueSchema,
  unexpectedStatus,
} from './firestore';

/** A claim on a project's sweep: the run sweeping it, the commit it sweeps, when it was taken. */
export type SweepClaim = {
  readonly runId: string;
  readonly headSha: string;
  readonly claimedAt: DateTime.Utc;
};

/**
 * The last sweep as stored: the API's, and the run that finished it. A finish that run retries is
 * recognised by it, so the run is kept here and not in what the API answers.
 */
const StoredLastSweepSchema = Schema.Struct({
  ...LastSweepSchema.fields,
  finishedBy: RunIdSchema,
});
export type StoredLastSweep = typeof StoredLastSweepSchema.Type;

/**
 * A project's sweep as it is stored: the threshold, the last finished sweep, the latest stopped
 * one since, the carry-over and the claim.
 */
export type SweepRecord = {
  readonly threshold: number;
  readonly last: StoredLastSweep | null;
  readonly stopped: StoppedSweep | null;
  readonly carryOver: readonly SweepFunction[];
  readonly claim: SweepClaim | null;
};

export type StoredSweep = {
  readonly sweep: SweepRecord;
  /** Changes with every write to the sweep, so a write can refuse a sweep read before a change. */
  readonly revision: string;
};

export class SweepStore extends Context.Service<
  SweepStore,
  {
    /** None when the project has no sweep yet: it reads as the defaults. */
    readonly get: (projectId: string) => Effect.Effect<Option.Option<StoredSweep>>;
    /**
     * Writes the project's sweep whole. With `expectedRevision`, only while the sweep is at it; with
     * none, only if the project has no sweep yet. False, and nothing written, when it isn't.
     */
    readonly write: (input: {
      readonly projectId: string;
      readonly sweep: SweepRecord;
      readonly expectedRevision: Option.Option<string>;
    }) => Effect.Effect<boolean>;
  }
>()('@codetinder/server/SweepStore') {
  static readonly memory = Layer.effect(
    SweepStore,
    Effect.gen(function* () {
      const sweeps = yield* Ref.make(new Map<string, StoredSweep>());

      const get = Effect.fn('SweepStore.get')(function* (projectId: string) {
        return Option.fromNullishOr((yield* Ref.get(sweeps)).get(projectId));
      });

      const write = Effect.fn('SweepStore.write')(function* ({
        projectId,
        sweep,
        expectedRevision,
      }: {
        readonly projectId: string;
        readonly sweep: SweepRecord;
        readonly expectedRevision: Option.Option<string>;
      }) {
        return yield* Ref.modify(sweeps, map => {
          const held = map.get(projectId);
          const isExpected = Option.match(expectedRevision, {
            onNone: () => held === undefined,
            onSome: revision => held?.revision === revision,
          });
          if (!isExpected) return [false, map] as const;
          const stored: StoredSweep = { sweep, revision: crypto.randomUUID() };
          return [true, new Map(map).set(projectId, stored)] as const;
        });
      });

      return SweepStore.of({ get, write });
    }),
  );

  static readonly firestore = Layer.effect(
    SweepStore,
    Effect.gen(function* () {
      const { documentsUrl, documentName, execute } = yield* firestoreConnection;

      const get = Effect.fn('SweepStore.get')(function* (projectId: string) {
        const request = HttpClientRequest.get(`${documentsUrl}/sweeps/${projectId}`);
        const response = yield* execute(request);
        if (response.status === 404) return Option.none();
        if (response.status !== 200) return yield* unexpectedStatus(request, response);
        const document = yield* HttpClientResponse.schemaBodyJson(SweepDocumentSchema)(
          response,
        ).pipe(Effect.orDie);
        return Option.some(yield* decodeStoredSweep(document));
      });

      /**
       * A commit that sets the sweep whole, with a precondition: `exists: false` to create it, or
       * the `updateTime` it was read at. Each refused precondition is a lost race, not a fault: a
       * create that found the document is ALREADY_EXISTS (409), a stale `updateTime` FAILED_PRECONDITION
       * (400). Both answers were checked against a live Firestore database.
       */
      const write = Effect.fn('SweepStore.write')(function* ({
        projectId,
        sweep,
        expectedRevision,
      }: {
        readonly projectId: string;
        readonly sweep: SweepRecord;
        readonly expectedRevision: Option.Option<string>;
      }) {
        const fields = yield* encodeSweepFields(sweep);
        const lostRace = Option.isNone(expectedRevision)
          ? { status: 409, error: 'ALREADY_EXISTS' }
          : { status: 400, error: 'FAILED_PRECONDITION' };
        const currentDocument = Option.match(expectedRevision, {
          onNone: () => ({ exists: false }),
          onSome: updateTime => ({ updateTime }),
        });
        const request = HttpClientRequest.post(`${documentsUrl}:commit`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            writes: [
              { update: { name: documentName(`sweeps/${projectId}`), fields }, currentDocument },
            ],
          }),
        );
        const response = yield* execute(request);
        if (response.status >= 200 && response.status < 300) return true;
        if (
          response.status === lostRace.status &&
          (yield* errorStatus(response)) === lostRace.error
        ) {
          return false;
        }
        return yield* unexpectedStatus(request, response);
      });

      return SweepStore.of({ get, write });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

// The threshold is an integer field; the rest is JSON in a string field, each decoded and encoded
// by the schema that describes it, so the stored form and the type can't drift apart. Dates go
// through the JSON codec, which writes them as ISO strings.
const LastSweepJsonSchema = Schema.fromJsonString(Schema.toCodecJson(StoredLastSweepSchema));
const StoppedSweepJsonSchema = Schema.fromJsonString(Schema.toCodecJson(StoppedSweepSchema));
const CarryOverJsonSchema = Schema.fromJsonString(Schema.Array(SweepFunctionSchema));
const SweepClaimJsonSchema = Schema.fromJsonString(
  Schema.toCodecJson(
    Schema.Struct({
      runId: RunIdSchema,
      headSha: CommitShaSchema,
      claimedAt: Schema.DateTimeUtc,
    }),
  ),
);

const SweepDocumentSchema = Schema.Struct({
  fields: Schema.Struct({
    threshold: IntegerValueSchema,
    carryOver: StringValueSchema,
    // Absent until a sweep has finished.
    last: Schema.optionalKey(StringValueSchema),
    // Absent unless the latest sweep stopped short.
    stopped: Schema.optionalKey(StringValueSchema),
    // Absent while no run holds the sweep.
    claim: Schema.optionalKey(StringValueSchema),
  }),
  updateTime: Schema.String,
});

const encodeSweepFields = Effect.fn('SweepStore.encodeSweepFields')(function* (sweep: SweepRecord) {
  const carryOver = yield* Schema.encodeEffect(CarryOverJsonSchema)(sweep.carryOver).pipe(
    Effect.orDie,
  );
  const last =
    sweep.last === null
      ? undefined
      : yield* Schema.encodeEffect(LastSweepJsonSchema)(sweep.last).pipe(Effect.orDie);
  const stopped =
    sweep.stopped === null
      ? undefined
      : yield* Schema.encodeEffect(StoppedSweepJsonSchema)(sweep.stopped).pipe(Effect.orDie);
  const claim =
    sweep.claim === null
      ? undefined
      : yield* Schema.encodeEffect(SweepClaimJsonSchema)(sweep.claim).pipe(Effect.orDie);
  return {
    threshold: { integerValue: String(sweep.threshold) },
    carryOver: { stringValue: carryOver },
    ...(last === undefined ? {} : { last: { stringValue: last } }),
    ...(stopped === undefined ? {} : { stopped: { stringValue: stopped } }),
    ...(claim === undefined ? {} : { claim: { stringValue: claim } }),
  };
});

const decodeStoredSweep = Effect.fn('SweepStore.decodeStoredSweep')(function* ({
  fields,
  updateTime,
}: typeof SweepDocumentSchema.Type) {
  const threshold = yield* Schema.decodeUnknownEffect(SweepThresholdSchema)(
    Number(fields.threshold.integerValue),
  ).pipe(Effect.orDie);
  const carryOver = yield* Schema.decodeEffect(CarryOverJsonSchema)(
    fields.carryOver.stringValue,
  ).pipe(Effect.orDie);
  const last =
    fields.last === undefined
      ? null
      : yield* Schema.decodeEffect(LastSweepJsonSchema)(fields.last.stringValue).pipe(Effect.orDie);
  const stopped =
    fields.stopped === undefined
      ? null
      : yield* Schema.decodeEffect(StoppedSweepJsonSchema)(fields.stopped.stringValue).pipe(
          Effect.orDie,
        );
  const claim =
    fields.claim === undefined
      ? null
      : yield* Schema.decodeEffect(SweepClaimJsonSchema)(fields.claim.stringValue).pipe(
          Effect.orDie,
        );
  return { sweep: { threshold, last, stopped, carryOver, claim }, revision: updateTime };
});
