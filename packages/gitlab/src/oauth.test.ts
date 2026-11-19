import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as TestClock from 'effect/testing/TestClock';
import { GITLAB_BASE_URL } from './gitlab';
import {
  deriveCodeChallenge,
  GitLabOAuth,
  generateCodeVerifier,
  generateState,
  OAuthError,
} from './oauth';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withOAuth = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabOAuth.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

describe('PKCE helpers', () => {
  it.effect('generates 43-character base64url verifier', () =>
    Effect.sync(() => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }),
  );

  it.effect('generates base64url state', () =>
    Effect.sync(() => {
      const state = generateState();
      expect(state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }),
  );

  it.effect('derives S256 code challenge correctly', () =>
    Effect.gen(function* () {
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
      const challenge = yield* deriveCodeChallenge(verifier);
      expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    }),
  );
});

describe('GitLabOAuth.buildAuthorizeUrl', () => {
  it.effect('constructs correct authorization URL with PKCE parameters', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const url = oauth.buildAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'https://codetinder.dev/auth/callback',
        state: 'xyz-state',
        codeChallenge: 'chall-456',
        scope: 'api',
      });

      const parsed = new URL(url);
      expect(parsed.origin).toBe(GITLAB_BASE_URL);
      expect(parsed.pathname).toBe('/oauth/authorize');
      expect(parsed.searchParams.get('client_id')).toBe('client-123');
      expect(parsed.searchParams.get('redirect_uri')).toBe('https://codetinder.dev/auth/callback');
      expect(parsed.searchParams.get('response_type')).toBe('code');
      expect(parsed.searchParams.get('state')).toBe('xyz-state');
      expect(parsed.searchParams.get('code_challenge')).toBe('chall-456');
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('scope')).toBe('api');
    }).pipe(Effect.provide(GitLabOAuth.layer)),
  );
});

describe('GitLabOAuth.exchangeCode', () => {
  it.effect('exchanges authorization code for token on 200', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const token = yield* oauth.exchangeCode({
        clientId: 'client-123',
        redirectUri: 'https://codetinder.dev/auth/callback',
        code: 'auth-code-789',
        codeVerifier: 'verifier-abc',
      });

      expect(token).toEqual({
        accessToken: 'access-token-123',
        tokenType: 'Bearer',
        refreshToken: 'refresh-token-456',
        scope: 'api',
        createdAt: 1700000000,
        expiresIn: 7200,
      });
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(async request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/oauth/token`);
            expect(request.method).toBe('POST');
            const body = await request.text();
            const params = new URLSearchParams(body);
            expect(params.get('client_id')).toBe('client-123');
            expect(params.get('grant_type')).toBe('authorization_code');
            expect(params.get('code')).toBe('auth-code-789');
            expect(params.get('redirect_uri')).toBe('https://codetinder.dev/auth/callback');
            expect(params.get('code_verifier')).toBe('verifier-abc');

            return new Response(
              JSON.stringify({
                access_token: 'access-token-123',
                token_type: 'Bearer',
                refresh_token: 'refresh-token-456',
                scope: 'api',
                created_at: 1700000000,
                expires_in: 7200,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('fails with OAuthError on 400 error response', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const error = yield* Effect.flip(
        oauth.exchangeCode({
          clientId: 'client-123',
          redirectUri: 'https://codetinder.dev/auth/callback',
          code: 'bad-code',
          codeVerifier: 'verifier-abc',
        }),
      );

      expect(error).toBeInstanceOf(OAuthError);
      expect(error.error).toBe('invalid_grant');
      expect(error.message).toMatch(/code is invalid/);
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(
            () =>
              new Response(
                JSON.stringify({
                  error: 'invalid_grant',
                  error_description: 'The provided authorization code is invalid.',
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              ),
          ),
        ),
      ),
    ),
  );

  it.effect('dies on 500 server error response', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const exit = yield* Effect.exit(
        oauth.exchangeCode({
          clientId: 'client-123',
          redirectUri: 'https://codetinder.dev/auth/callback',
          code: 'code',
          codeVerifier: 'verifier',
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(
            () =>
              new Response('Internal Server Error', {
                status: 500,
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('dies when GitLab does not answer within 10 seconds', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          oauth.exchangeCode({
            clientId: 'client-123',
            redirectUri: 'https://codetinder.dev/auth/callback',
            code: 'code',
            codeVerifier: 'verifier',
          }),
        ),
      );
      yield* TestClock.adjust('10 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(Effect.provide(withOAuth(scriptedFetch(() => new Promise<Response>(() => {}))))),
  );
});

describe('GitLabOAuth.refreshToken', () => {
  it.effect('refreshes token successfully', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const token = yield* oauth.refreshToken({
        clientId: 'client-123',
        refreshToken: 'refresh-token-old',
      });

      expect(token.accessToken).toBe('access-token-new');
      expect(token.refreshToken).toBe('refresh-token-new');
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(async request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/oauth/token`);
            const body = await request.text();
            const params = new URLSearchParams(body);
            expect(params.get('client_id')).toBe('client-123');
            expect(params.get('grant_type')).toBe('refresh_token');
            expect(params.get('refresh_token')).toBe('refresh-token-old');

            return new Response(
              JSON.stringify({
                access_token: 'access-token-new',
                token_type: 'Bearer',
                refresh_token: 'refresh-token-new',
                scope: 'api',
                created_at: 1700003600,
                expires_in: 7200,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('fails with OAuthError on 400 invalid_grant', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const error = yield* Effect.flip(
        oauth.refreshToken({
          clientId: 'client-123',
          refreshToken: 'revoked-token',
        }),
      );

      expect(error).toBeInstanceOf(OAuthError);
      expect(error.error).toBe('invalid_grant');
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(
            () =>
              new Response(
                JSON.stringify({
                  error: 'invalid_grant',
                  error_description: 'The refresh token is invalid.',
                }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              ),
          ),
        ),
      ),
    ),
  );

  it.effect('dies on 500 transient failure', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const exit = yield* Effect.exit(
        oauth.refreshToken({
          clientId: 'client-123',
          refreshToken: 'token',
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(
            () =>
              new Response('Bad Gateway', {
                status: 502,
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('dies when the body stalls after the headers, within 10 seconds', () =>
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      const fiber = yield* Effect.forkChild(
        Effect.exit(oauth.refreshToken({ clientId: 'client-123', refreshToken: 'token' })),
      );
      yield* TestClock.adjust('10 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(
            () =>
              new Response(new ReadableStream({ start: () => {} }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('sends no trace headers, which the token endpoint refuses in a browser', () => {
    const sent: string[] = [];
    return Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;
      yield* Effect.exit(oauth.refreshToken({ clientId: 'client-123', refreshToken: 'token' }));
      expect(sent).toEqual(['content-type']);
    }).pipe(
      Effect.provide(
        withOAuth(
          scriptedFetch(request => {
            sent.push(...request.headers.keys());
            return new Response('{}', { status: 400 });
          }),
        ),
      ),
    );
  });
});
