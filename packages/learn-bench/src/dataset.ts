import { RoundSchema, VerdictsSchema } from '@codetinder/core';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';

/** One round a developer judged, with every developer's verdicts on it. */
export const JudgedRoundSchema = Schema.Struct({
  id: Schema.String,
  mergeRequestIid: Schema.Int,
  createdAt: Schema.String,
  round: RoundSchema,
  verdicts: Schema.Array(VerdictsSchema),
});
export type JudgedRound = typeof JudgedRoundSchema.Type;

/** A project's judged rounds, oldest first: the order learn met them in. */
export const DatasetSchema = Schema.Struct({
  projectId: Schema.String,
  rounds: Schema.Array(JudgedRoundSchema),
});
export type Dataset = typeof DatasetSchema.Type;

export const DatasetJsonSchema = Schema.fromJsonString(DatasetSchema);

/** codetinder.dev's Google Cloud project, whose Firestore holds every round and swipe. */
const GCP_PROJECT = 'codetinder';
const RUN_QUERY_URL = `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/documents:runQuery`;

const StringValueSchema = Schema.Struct({ stringValue: Schema.String });

const RoundDocumentSchema = Schema.Struct({
  name: Schema.String,
  fields: Schema.Struct({
    round: StringValueSchema,
    mergeRequestIid: Schema.Struct({ integerValue: Schema.String }),
    createdAt: Schema.Struct({ timestampValue: Schema.String }),
  }),
});

const SwipeDocumentSchema = Schema.Struct({
  fields: Schema.Struct({ roundId: StringValueSchema, verdicts: StringValueSchema }),
});

const queryResponseSchema = <S extends Schema.Top>(document: S) =>
  Schema.Array(Schema.Struct({ document: Schema.optional(document) }));

/**
 * Reads a project's rounds and swipes from Firestore with the caller's own Google credentials
 * (`GOOGLE_ACCESS_TOKEN`, e.g. from `gcloud auth print-access-token`). Rounds of an older format,
 * and rounds nobody swiped, teach learn nothing and are left out.
 */
export const fetchDataset = Effect.fn('dataset.fetch')(function* (projectId: string) {
  const token = yield* Config.Redacted('GOOGLE_ACCESS_TOKEN');
  const http = yield* HttpClient.HttpClient;

  const runQuery = <S extends Schema.Codec<unknown, unknown>>(collectionId: string, document: S) =>
    HttpClientRequest.post(RUN_QUERY_URL).pipe(
      HttpClientRequest.bearerToken(token),
      HttpClientRequest.setHeader('x-goog-user-project', GCP_PROJECT),
      HttpClientRequest.bodyJsonUnsafe({
        structuredQuery: {
          from: [{ collectionId }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'projectId' },
              op: 'EQUAL',
              value: { stringValue: projectId },
            },
          },
        },
      }),
      http.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(queryResponseSchema(document))),
      Effect.map(results => results.flatMap(({ document }) => (document ? [document] : []))),
      Effect.orDie,
    );

  const [roundDocuments, swipeDocuments] = yield* Effect.all(
    [runQuery('rounds', RoundDocumentSchema), runQuery('swipes', SwipeDocumentSchema)],
    { concurrency: 2 },
  );

  const swipes = yield* Effect.forEach(
    swipeDocuments,
    ({ fields }) =>
      Schema.decodeEffect(Schema.fromJsonString(VerdictsSchema))(fields.verdicts.stringValue).pipe(
        Effect.map(verdicts => ({ roundId: fields.roundId.stringValue, verdicts })),
      ),
    { concurrency: 1 },
  ).pipe(Effect.orDie);
  const verdictsByRound = Map.groupBy(swipes, ({ roundId }) => roundId);

  const rounds = roundDocuments.flatMap(({ name, fields }) => {
    const round = Schema.decodeOption(Schema.fromJsonString(RoundSchema))(fields.round.stringValue);
    const id = name.split('/').at(-1) ?? name;
    const verdicts = (verdictsByRound.get(id) ?? [])
      .map(({ verdicts }) => verdicts)
      .filter(verdicts => Object.keys(verdicts).length > 0);
    if (Option.isNone(round) || verdicts.length === 0) return [];
    return [
      {
        id,
        mergeRequestIid: Number(fields.mergeRequestIid.integerValue),
        createdAt: fields.createdAt.timestampValue,
        round: round.value,
        verdicts,
      },
    ];
  });

  return {
    projectId,
    rounds: rounds.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  } satisfies Dataset;
});
