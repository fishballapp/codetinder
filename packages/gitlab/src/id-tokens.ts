import * as Cache from 'effect/Cache';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as Ref from 'effect/Ref';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import {
  CODETINDER_AUDIENCE,
  GITLAB_JWKS_URL,
  ID_TOKEN_ISSUER,
  ID_TOKEN_LEEWAY_SECONDS,
  ID_TOKEN_PIPELINE_SOURCE,
  REQUEST_TIMEOUT,
} from './gitlab';

const JWKS_KEY = 'jwks';
const JWKS_TTL = '1 hour';
/** A kid missing from the cached keys may be a rotated key: refetch for it at most this often. */
const UNKNOWN_KID_REFRESH_MS = 60_000;

export type FlowClaims = {
  readonly projectId: string;
  readonly projectPath: string;
  readonly userLogin?: string;
};

export class InvalidIdToken extends Schema.TaggedError<InvalidIdToken>()('InvalidIdToken', {
  message: Schema.String,
}) {}

const JwtHeaderSchema = Schema.Struct({
  alg: Schema.String,
  kid: Schema.optionalKey(Schema.String),
});

const JwtPayloadSchema = Schema.Struct({
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nbf: Schema.optionalKey(Schema.Finite),
  pipeline_source: Schema.String,
  project_id: Schema.Union([Schema.String, Schema.Finite]),
  project_path: Schema.String,
  user_login: Schema.optionalKey(Schema.String),
});
type JwtPayload = typeof JwtPayloadSchema.Type;

const JwkSchema = Schema.Struct({
  kid: Schema.optionalKey(Schema.String),
  kty: Schema.String,
  alg: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  n: Schema.String,
  e: Schema.String,
});
type Jwk = typeof JwkSchema.Type;

const JwksSchema = Schema.Struct({
  keys: Schema.Array(JwkSchema),
});
type Jwks = typeof JwksSchema.Type;

const JwtHeaderFromPart = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(JwtHeaderSchema)),
);
const JwtPayloadFromPart = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(JwtPayloadSchema)),
);

export class GitLabIdTokens extends Context.Service<
  GitLabIdTokens,
  {
    readonly verify: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<FlowClaims, InvalidIdToken>;
  }
>()('@codetinder/gitlab/GitLabIdTokens') {
  static readonly layer = Layer.effect(
    GitLabIdTokens,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.transformResponse(response =>
          response.pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catchTag('TimeoutError', error => Effect.die(error)),
          ),
        ),
      );
      // A failed fetch is not kept: the next verification asks GitLab again.
      const jwksCache = yield* Cache.makeWith<string, Jwks>(() => fetchJwks(http), {
        capacity: 1,
        timeToLive: exit => (Exit.isFailure(exit) ? Duration.zero : JWKS_TTL),
      });
      const lastUnknownKidRefresh = yield* Ref.make(Number.NEGATIVE_INFINITY);

      const lookupJwk = Effect.fn('GitLabIdTokens.lookupJwk')(function* (kid: string) {
        const cached = yield* Cache.get(jwksCache, JWKS_KEY);
        const fromCache = cached.keys.find(key => key.kid === kid);
        if (fromCache !== undefined) return fromCache;

        const unknown = new InvalidIdToken({ message: 'token kid is unknown' });
        const nowMs = yield* Clock.currentTimeMillis;
        const lastRefreshMs = yield* Ref.get(lastUnknownKidRefresh);
        if (nowMs - lastRefreshMs < UNKNOWN_KID_REFRESH_MS) return yield* unknown;

        yield* Ref.set(lastUnknownKidRefresh, nowMs);
        yield* Cache.invalidate(jwksCache, JWKS_KEY);
        const refreshed = yield* Cache.get(jwksCache, JWKS_KEY);
        const fromRefresh = refreshed.keys.find(key => key.kid === kid);
        if (fromRefresh !== undefined) return fromRefresh;
        return yield* unknown;
      });

      const verify = Effect.fn('GitLabIdTokens.verify')(function* (
        token: Redacted.Redacted<string>,
      ) {
        const [headerPart, payloadPart, signaturePart, ...rest] = Redacted.value(token).split('.');
        if (
          rest.length > 0 ||
          headerPart === undefined ||
          payloadPart === undefined ||
          signaturePart === undefined
        ) {
          return yield* new InvalidIdToken({ message: 'token is not a JWT' });
        }

        const header = yield* Schema.decodeEffect(JwtHeaderFromPart)(headerPart).pipe(
          Effect.mapError(() => new InvalidIdToken({ message: 'token header is invalid' })),
        );
        if (header.alg !== 'RS256') {
          return yield* new InvalidIdToken({ message: 'token algorithm is not RS256' });
        }
        if (header.kid === undefined) {
          return yield* new InvalidIdToken({ message: 'token header has no kid' });
        }

        const payload = yield* Schema.decodeEffect(JwtPayloadFromPart)(payloadPart).pipe(
          Effect.mapError(() => new InvalidIdToken({ message: 'token payload is invalid' })),
        );

        const jwk = yield* lookupJwk(header.kid);
        const signature = yield* decodeSignature(signaturePart);
        const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
        const key = yield* importVerifyKey(jwk);
        const isValid = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.verify(
              { name: 'RSASSA-PKCS1-v1_5' },
              key,
              // WebCrypto wants an ArrayBuffer-backed view; Base64Url may return SharedArrayBuffer.
              new Uint8Array(signature),
              signingInput,
            ),
          catch: () => new InvalidIdToken({ message: 'token signature could not be verified' }),
        });
        if (!isValid) {
          return yield* new InvalidIdToken({ message: 'token signature is invalid' });
        }

        // Only a payload GitLab signed is worth reading.
        yield* assertClaims(payload);
        return toFlowClaims(payload);
      });

      return GitLabIdTokens.of({ verify });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}

const decodeSignature = (part: string): Effect.Effect<Uint8Array, InvalidIdToken> =>
  Result.match(Base64Url.decode(part), {
    onSuccess: bytes => Effect.succeed(bytes),
    onFailure: () =>
      Effect.fail(new InvalidIdToken({ message: 'token signature is not base64url' })),
  });

const fetchJwks = (http: HttpClient.HttpClient): Effect.Effect<Jwks> =>
  http
    .get(GITLAB_JWKS_URL)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(JwksSchema)),
      Effect.orDie,
    );

const importVerifyKey = (jwk: Jwk) =>
  Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        'jwk',
        {
          kty: jwk.kty,
          n: jwk.n,
          e: jwk.e,
          alg: jwk.alg ?? 'RS256',
          ext: true,
        },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    catch: () => new InvalidIdToken({ message: 'token key could not be imported' }),
  });

const assertClaims = (payload: JwtPayload): Effect.Effect<void, InvalidIdToken> =>
  Effect.gen(function* () {
    if (payload.iss !== ID_TOKEN_ISSUER) {
      return yield* new InvalidIdToken({ message: 'token issuer is wrong' });
    }
    if (!audienceIncludes(payload.aud, CODETINDER_AUDIENCE)) {
      return yield* new InvalidIdToken({ message: 'token audience is wrong' });
    }
    if (payload.pipeline_source !== ID_TOKEN_PIPELINE_SOURCE) {
      return yield* new InvalidIdToken({ message: 'token pipeline_source is wrong' });
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const leewayMs = ID_TOKEN_LEEWAY_SECONDS * 1000;
    if (payload.exp * 1000 < nowMs - leewayMs) {
      return yield* new InvalidIdToken({ message: 'token is expired' });
    }
    if (payload.nbf !== undefined && payload.nbf * 1000 > nowMs + leewayMs) {
      return yield* new InvalidIdToken({ message: 'token is not yet valid' });
    }
  });

const audienceIncludes = (aud: string | ReadonlyArray<string>, expected: string): boolean =>
  typeof aud === 'string' ? aud === expected : aud.includes(expected);

const toFlowClaims = (payload: JwtPayload): FlowClaims => ({
  projectId: String(payload.project_id),
  projectPath: payload.project_path,
  ...(payload.user_login !== undefined ? { userLogin: payload.user_login } : {}),
});
