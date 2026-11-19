import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Base64Url from 'effect/encoding/Base64Url';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as TestClock from 'effect/testing/TestClock';
import {
  CODETINDER_AUDIENCE,
  GITLAB_JWKS_URL,
  ID_TOKEN_ISSUER,
  ID_TOKEN_PIPELINE_SOURCE,
} from './gitlab';
import { GitLabIdTokens } from './id-tokens';

type Jwk = JsonWebKey & { kid?: string };

const textEncoder = new TextEncoder();
const NOW_SEC = 1_700_000_000;

const generateRsa = () =>
  Effect.promise(() =>
    crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    ),
  ).pipe(
    Effect.flatMap(pair =>
      Effect.promise(() => crypto.subtle.exportKey('jwk', pair.publicKey)).pipe(
        Effect.map(
          jwk =>
            ({
              privateKey: pair.privateKey,
              jwk: { ...jwk, kid: 'test-kid', alg: 'RS256', use: 'sig' } satisfies Jwk,
            }) as const,
        ),
      ),
    ),
  );

const signJwt = ({
  privateKey,
  kid,
  payload,
}: {
  privateKey: CryptoKey;
  kid: string;
  payload: Record<string, unknown>;
}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const header = Base64Url.encode(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const body = Base64Url.encode(JSON.stringify(payload));
    const signingInput = `${header}.${body}`;
    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      textEncoder.encode(signingInput),
    );
    return `${signingInput}.${Base64Url.encode(new Uint8Array(signature))}`;
  });

const baseClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: ID_TOKEN_ISSUER,
  aud: CODETINDER_AUDIENCE,
  exp: NOW_SEC + 3600,
  nbf: NOW_SEC - 5,
  pipeline_source: ID_TOKEN_PIPELINE_SOURCE,
  project_id: '87434709',
  project_path: 'group/project',
  user_login: 'ai-codetinder-group',
  ...overrides,
});

const jwksResponse = (keys: ReadonlyArray<Jwk>) =>
  new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const scriptedFetch = (
  handler: (url: string) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async input => {
    const url = (() => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      return input.url;
    })();
    return handler(url);
  };
  return fetch;
};

const withIdTokens = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabIdTokens.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const verifyAtNow = (token: string, fetch: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_SEC * 1000);
    const gitlab = yield* GitLabIdTokens;
    return yield* gitlab.verify(Redacted.make(token));
  }).pipe(Effect.provide(withIdTokens(fetch)));

const expectInvalid = (token: string, fetch: typeof globalThis.fetch, message: RegExp) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(verifyAtNow(token, fetch));
    expect(error._tag).toBe('InvalidIdToken');
    expect(error.message).toMatch(message);
  });

describe('GitLabIdTokens.verify', () => {
  it.effect('accepts a valid token', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims(),
      });
      const claims = yield* verifyAtNow(
        token,
        scriptedFetch(url => {
          expect(url).toBe(GITLAB_JWKS_URL);
          return jwksResponse([jwk]);
        }),
      );
      expect(claims).toEqual({
        projectId: '87434709',
        projectPath: 'group/project',
        userLogin: 'ai-codetinder-group',
      });
    }),
  );

  it.effect('accepts aud as an array containing the audience', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ aud: ['https://other.app', CODETINDER_AUDIENCE] }),
      });
      const claims = yield* verifyAtNow(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
      );
      expect(claims.projectId).toBe('87434709');
    }),
  );

  it.effect('accepts a token inside the leeway window', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      // exp is 30s in the past; 60s leeway still accepts it
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ exp: NOW_SEC - 30, nbf: NOW_SEC - 100 }),
      });
      const claims = yield* verifyAtNow(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
      );
      expect(claims.projectPath).toBe('group/project');
    }),
  );

  it.effect('rejects an expired token', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ exp: NOW_SEC - 120 }),
      });
      yield* expectInvalid(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
        /expired/,
      );
    }),
  );

  it.effect('rejects a token that is not yet valid', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ nbf: NOW_SEC + 120 }),
      });
      yield* expectInvalid(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
        /not yet valid/,
      );
    }),
  );

  it.effect('rejects the wrong issuer', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ iss: 'https://evil.example' }),
      });
      yield* expectInvalid(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
        /issuer/,
      );
    }),
  );

  it.effect('rejects the wrong audience', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ aud: 'https://evil.example' }),
      });
      yield* expectInvalid(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
        /audience/,
      );
    }),
  );

  it.effect('rejects the wrong pipeline_source', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ pipeline_source: 'push' }),
      });
      yield* expectInvalid(
        token,
        scriptedFetch(() => jwksResponse([jwk])),
        /pipeline_source/,
      );
    }),
  );

  it.effect('rejects a tampered payload', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims(),
      });
      const [header, , signature] = token.split('.');
      const tamperedPayload = Base64Url.encode(JSON.stringify(baseClaims({ project_id: '999' })));
      const tampered = `${header}.${tamperedPayload}.${signature}`;
      yield* expectInvalid(
        tampered,
        scriptedFetch(() => jwksResponse([jwk])),
        /signature/,
      );
    }),
  );

  it.effect('refetches JWKS once for an unknown kid, then fails', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({
        privateKey,
        kid: 'missing-kid',
        payload: baseClaims(),
      });
      const fetches: string[] = [];
      const fetch = scriptedFetch(url => {
        fetches.push(url);
        return jwksResponse([jwk]);
      });
      yield* expectInvalid(token, fetch, /kid is unknown/);
      expect(fetches).toEqual([GITLAB_JWKS_URL, GITLAB_JWKS_URL]);
    }),
  );

  it.effect('fetches JWKS once across two verifications', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const tokenA = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ project_id: '1' }),
      });
      const tokenB = yield* signJwt({
        privateKey,
        kid: 'test-kid',
        payload: baseClaims({ project_id: '2' }),
      });
      const fetches: string[] = [];
      const fetch = scriptedFetch(url => {
        fetches.push(url);
        return jwksResponse([jwk]);
      });
      yield* TestClock.setTime(NOW_SEC * 1000);
      yield* Effect.gen(function* () {
        const gitlab = yield* GitLabIdTokens;
        expect((yield* gitlab.verify(Redacted.make(tokenA))).projectId).toBe('1');
        expect((yield* gitlab.verify(Redacted.make(tokenB))).projectId).toBe('2');
      }).pipe(Effect.provide(withIdTokens(fetch)));
      expect(fetches).toEqual([GITLAB_JWKS_URL]);
    }),
  );
});

describe('GitLabIdTokens JWKS cache', () => {
  it.effect('retries a failed JWKS fetch on the next verification', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const token = yield* signJwt({ privateKey, kid: 'test-kid', payload: baseClaims() });
      const answer = { healthy: false };
      const fetch = scriptedFetch(() =>
        answer.healthy ? jwksResponse([jwk]) : new Response('', { status: 503 }),
      );
      return yield* Effect.gen(function* () {
        yield* TestClock.setTime(NOW_SEC * 1000);
        const gitlab = yield* GitLabIdTokens;

        expect(Exit.hasDies(yield* Effect.exit(gitlab.verify(Redacted.make(token))))).toBe(true);

        answer.healthy = true;
        const claims = yield* gitlab.verify(Redacted.make(token));
        expect(claims.projectId).toBe('87434709');
      }).pipe(Effect.provide(withIdTokens(fetch)));
    }),
  );

  it.effect('refetches JWKS for an unknown kid at most once a minute', () =>
    Effect.gen(function* () {
      const { privateKey, jwk } = yield* generateRsa();
      const fetches: string[] = [];
      const fetch = scriptedFetch(url => {
        fetches.push(url);
        return jwksResponse([jwk]);
      });
      return yield* Effect.gen(function* () {
        const gitlab = yield* GitLabIdTokens;
        const unknown = (kid: string) =>
          signJwt({ privateKey, kid, payload: baseClaims() }).pipe(
            Effect.flatMap(token => Effect.flip(gitlab.verify(Redacted.make(token)))),
          );
        yield* TestClock.setTime(NOW_SEC * 1000);
        const valid = yield* signJwt({ privateKey, kid: 'test-kid', payload: baseClaims() });
        yield* gitlab.verify(Redacted.make(valid));
        expect(fetches).toHaveLength(1);

        expect((yield* unknown('bogus-1')).message).toMatch(/kid is unknown/);
        expect(fetches).toHaveLength(2);

        yield* TestClock.adjust('30 seconds');
        expect((yield* unknown('bogus-2')).message).toMatch(/kid is unknown/);
        expect(fetches).toHaveLength(2);

        yield* TestClock.adjust('31 seconds');
        expect((yield* unknown('bogus-3')).message).toMatch(/kid is unknown/);
        expect(fetches).toHaveLength(3);
      }).pipe(Effect.provide(withIdTokens(fetch)));
    }),
  );

  it.effect('gives up on a JWKS fetch that does not answer within 10 seconds', () =>
    Effect.gen(function* () {
      const { privateKey } = yield* generateRsa();
      const token = yield* signJwt({ privateKey, kid: 'test-kid', payload: baseClaims() });
      const gitlab = yield* GitLabIdTokens;
      const fiber = yield* Effect.forkChild(Effect.exit(gitlab.verify(Redacted.make(token))));
      yield* TestClock.adjust('10 seconds');
      expect(Exit.hasDies(yield* Fiber.join(fiber))).toBe(true);
    }).pipe(Effect.provide(withIdTokens(scriptedFetch(() => new Promise<Response>(() => {}))))),
  );
});
