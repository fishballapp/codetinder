import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as UrlParams from 'effect/http/UrlParams';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { GITLAB_BASE_URL, REQUEST_TIMEOUT } from './gitlab';

export class OAuthError extends Schema.TaggedError<OAuthError>()('OAuthError', {
  message: Schema.String,
  error: Schema.optional(Schema.String),
  errorDescription: Schema.optional(Schema.String),
}) {}

export const GitLabOAuthTokenResponseSchema = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.String,
  created_at: Schema.Number,
  expires_in: Schema.Number,
});

export const GitLabOAuthErrorResponseSchema = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
});

export const GitLabOAuthTokenSchema = Schema.Struct({
  accessToken: Schema.String,
  tokenType: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  scope: Schema.String,
  createdAt: Schema.Number,
  expiresIn: Schema.Number,
});

export type GitLabOAuthToken = typeof GitLabOAuthTokenSchema.Type;

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      binary += String.fromCharCode(byte);
    }
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const generateCodeVerifier = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

export const generateState = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
};

export const deriveCodeChallenge = (verifier: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return base64UrlEncode(new Uint8Array(digest));
  });

export class GitLabOAuth extends Context.Service<
  GitLabOAuth,
  {
    readonly buildAuthorizeUrl: (args: {
      readonly clientId: string;
      readonly redirectUri: string;
      readonly state: string;
      readonly codeChallenge: string;
      readonly scope?: string;
    }) => string;
    readonly exchangeCode: (args: {
      readonly clientId: string;
      readonly redirectUri: string;
      readonly code: string;
      readonly codeVerifier: string;
    }) => Effect.Effect<GitLabOAuthToken, OAuthError>;
    readonly refreshToken: (args: {
      readonly clientId: string;
      readonly refreshToken: string;
    }) => Effect.Effect<GitLabOAuthToken, OAuthError>;
  }
>()('@codetinder/gitlab/GitLabOAuth') {
  static readonly layer = Layer.effect(
    GitLabOAuth,
    Effect.gen(function* () {
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(GITLAB_BASE_URL)),
        HttpClient.transformResponse(response =>
          response.pipe(
            Effect.timeout(REQUEST_TIMEOUT),
            Effect.catchTag('TimeoutError', error => Effect.die(error)),
          ),
        ),
      );

      const buildAuthorizeUrl = ({
        clientId,
        redirectUri,
        state,
        codeChallenge,
        scope = 'api',
      }: {
        readonly clientId: string;
        readonly redirectUri: string;
        readonly state: string;
        readonly codeChallenge: string;
        readonly scope?: string;
      }): string => {
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          state,
          scope,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
        });
        return `${GITLAB_BASE_URL}/oauth/authorize?${params.toString()}`;
      };

      // GitLab consumes the code (or rotates the refresh token) as soon as it answers, so this
      // request is never sent again, and has one deadline, body included: a stalled body can't hang
      // a sign-in.
      const requestToken = (params: UrlParams.UrlParams, purpose: string) =>
        Effect.gen(function* () {
          const response = yield* HttpClientRequest.post('/oauth/token').pipe(
            HttpClientRequest.bodyUrlParams(params),
            http.execute,
            Effect.orDie,
          );

          if (response.status === 200) {
            const body = yield* HttpClientResponse.schemaBodyJson(GitLabOAuthTokenResponseSchema)(
              response,
            ).pipe(Effect.orDie);
            return {
              accessToken: body.access_token,
              tokenType: body.token_type,
              ...(body.refresh_token !== undefined ? { refreshToken: body.refresh_token } : {}),
              scope: body.scope,
              createdAt: body.created_at,
              expiresIn: body.expires_in,
            };
          }

          // 400/401 are GitLab refusing the code or token; anything else is GitLab failing.
          if (response.status === 400 || response.status === 401) {
            const errBody = yield* HttpClientResponse.schemaBodyJson(
              GitLabOAuthErrorResponseSchema,
            )(response).pipe(Effect.option);
            return yield* new OAuthError({
              message: Option.match(errBody, {
                onNone: () => `OAuth token ${purpose} failed with status ${response.status}`,
                onSome: err => err.error_description ?? `OAuth error: ${err.error}`,
              }),
              error: Option.map(errBody, err => err.error).pipe(Option.getOrUndefined),
              errorDescription: Option.map(errBody, err => err.error_description).pipe(
                Option.getOrUndefined,
              ),
            });
          }

          return yield* Effect.die(
            new Error(`GitLab OAuth token ${purpose} unexpected status ${response.status}`),
          );
        }).pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.catchTag('TimeoutError', error => Effect.die(error)),
          // gitlab.com's CORS preflight for /oauth/token allows no request header but
          // content-type, so the browser would refuse a request carrying trace headers.
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        );

      const exchangeCode = Effect.fn('GitLabOAuth.exchangeCode')(function* ({
        clientId,
        redirectUri,
        code,
        codeVerifier,
      }: {
        readonly clientId: string;
        readonly redirectUri: string;
        readonly code: string;
        readonly codeVerifier: string;
      }) {
        const params = UrlParams.fromInput({
          client_id: clientId,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        });
        return yield* requestToken(params, 'exchange');
      });

      const refreshToken = Effect.fn('GitLabOAuth.refreshToken')(function* ({
        clientId,
        refreshToken: token,
      }: {
        readonly clientId: string;
        readonly refreshToken: string;
      }) {
        const params = UrlParams.fromInput({
          client_id: clientId,
          grant_type: 'refresh_token',
          refresh_token: token,
        });
        return yield* requestToken(params, 'refresh');
      });

      return GitLabOAuth.of({
        buildAuthorizeUrl,
        exchangeCode,
        refreshToken,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
