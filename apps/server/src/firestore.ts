import * as Cache from 'effect/Cache';
import * as Config from 'effect/Config';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';

/** Longest a call to Firestore or the metadata server may take; past it the call is a fault. */
const OUTBOUND_TIMEOUT = '10 seconds';

/**
 * The database a store reads and writes over Firestore's REST API: `documentName` names a document
 * in it, and `execute` sends a request authenticated as the service account. A call that fails
 * to reach Firestore is a fault.
 */
export const firestoreConnection = Effect.gen(function* () {
  const projectId = yield* Config.String('GCP_PROJECT').pipe(Config.withDefault('codetinder'));
  const databaseId = yield* Config.String('FIRESTORE_DATABASE').pipe(
    Config.withDefault('(default)'),
  );
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(response =>
      response.pipe(
        Effect.timeout(OUTBOUND_TIMEOUT),
        Effect.catchTag('TimeoutError', error => Effect.die(error)),
      ),
    ),
  );
  const getAccessToken = yield* metadataAccessTokenGetter(http);
  const documentsUrl = firestoreDocumentsUrl(projectId, databaseId);

  const execute = Effect.fn('firestore.execute')(function* (
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* getAccessToken();
    return yield* http.execute(HttpClientRequest.bearerToken(request, token)).pipe(Effect.orDie);
  });

  const documentName = (path: string) =>
    `projects/${projectId}/databases/${databaseId}/documents/${path}`;

  return { documentsUrl, documentName, execute };
});

/** Firestore's error status for a request it refused, read from its error body. */
export const errorStatus = Effect.fn('firestore.errorStatus')(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const error = yield* HttpClientResponse.schemaBodyJson(FirestoreErrorSchema)(response).pipe(
    Effect.orDie,
  );
  return error.error.status;
});

/** A response that is no answer the store plans for: a fault. */
export const unexpectedStatus = (
  request: HttpClientRequest.HttpClientRequest,
  response: HttpClientResponse.HttpClientResponse,
) => Effect.die(new Error(`Firestore ${request.method} ${request.url}: status ${response.status}`));

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

const TOKEN_REFRESH_SKEW_SECONDS = 60;

const MetadataTokenSchema = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Finite,
  token_type: Schema.String,
});

/** Cache the metadata-server OAuth token until 60 s before expires_in. */
const metadataAccessTokenGetter = (
  http: HttpClient.HttpClient,
): Effect.Effect<() => Effect.Effect<Redacted.Redacted<string>>> =>
  Effect.gen(function* () {
    const cache = yield* Cache.makeWith(() => fetchMetadataToken(http), {
      capacity: 1,
      timeToLive: exit => {
        if (Exit.isFailure(exit)) return Duration.zero;
        return Duration.seconds(Math.max(0, exit.value.expiresIn - TOKEN_REFRESH_SKEW_SECONDS));
      },
    });
    return () => Cache.get(cache, 'default').pipe(Effect.map(({ token }) => token));
  });

const fetchMetadataToken = (
  http: HttpClient.HttpClient,
): Effect.Effect<{ readonly token: Redacted.Redacted<string>; readonly expiresIn: number }> =>
  Effect.gen(function* () {
    const response = yield* HttpClientRequest.get(METADATA_TOKEN_URL).pipe(
      HttpClientRequest.setHeader('Metadata-Flavor', 'Google'),
      http.execute,
      Effect.orDie,
    );
    if (response.status !== 200) {
      return yield* Effect.die(new Error(`metadata token unexpected status ${response.status}`));
    }
    const body = yield* HttpClientResponse.schemaBodyJson(MetadataTokenSchema)(response).pipe(
      Effect.orDie,
    );
    return {
      token: Redacted.make(body.access_token),
      expiresIn: body.expires_in,
    };
  });

const firestoreDocumentsUrl = (projectId: string, databaseId: string): string =>
  `https://firestore.googleapis.com/v1/projects/${projectId}/databases/${encodeURIComponent(databaseId)}/documents`;

// Firestore Value JSON: integerValue is a decimal string, timestampValue an RFC 3339 string.
// https://firebase.google.com/docs/firestore/reference/rest/Shared.Types/ArrayValue#Value
export const StringValueSchema = Schema.Struct({ stringValue: Schema.String });
export const IntegerValueSchema = Schema.Struct({ integerValue: Schema.String });
export const TimestampValueSchema = Schema.Struct({ timestampValue: Schema.String });

export const FirestoreErrorSchema = Schema.Struct({
  error: Schema.Struct({ status: Schema.String }),
});
