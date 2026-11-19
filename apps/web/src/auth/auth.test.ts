import { GitLabOAuth, GitLabProjects } from '@codetinder/gitlab';
import { beforeEach, describe, expect, it } from '@effect/vitest';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { authCallbackAtom } from '../state/atoms';
import { webRuntime } from '../state/runtime';
import {
  completeSignIn,
  decodeStoredToken,
  encodeStoredToken,
  isTokenExpired,
  Session,
  SignInFailed,
  type StoredToken,
} from './auth';

class MockStorage {
  private store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const mockOAuthLayer = Layer.succeed(
  GitLabOAuth,
  GitLabOAuth.of({
    buildAuthorizeUrl: () => 'https://gitlab.com/oauth/authorize?test=1',
    exchangeCode: () =>
      Effect.succeed({
        accessToken: 'exchanged-token',
        tokenType: 'Bearer',
        refreshToken: 'exchanged-refresh',
        scope: 'api',
        createdAt: 1000,
        expiresIn: 7200,
      }),
    refreshToken: () =>
      Effect.succeed({
        accessToken: 'new-refreshed-token',
        tokenType: 'Bearer',
        refreshToken: 'new-refresh-token',
        scope: 'api',
        createdAt: 1000,
        expiresIn: 7200,
      }),
  }),
);

const sessionTestLayer = Session.layer.pipe(Layer.provide(mockOAuthLayer));

describe('auth storage and token management', () => {
  beforeEach(() => {
    const mockLocal = new MockStorage();
    const mockSession = new MockStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      value: mockLocal,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: mockSession,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: {
          origin: 'http://localhost:5173',
          pathname: '/',
          search: '',
        },
      },
      writable: true,
      configurable: true,
    });

    let lockQueue = Promise.resolve();
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        locks: {
          request: async (_name: string, callback: () => Promise<unknown>) => {
            const next = lockQueue.then(() => callback());
            lockQueue = next.then(
              () => {},
              () => {},
            );
            return next;
          },
        },
      },
      writable: true,
      configurable: true,
    });
  });

  it('decodes and encodes stored tokens without try/catch', () => {
    const token = {
      accessToken: 'token-123',
      tokenType: 'Bearer',
      refreshToken: 'refresh-456',
      scope: 'api',
      createdAt: 1000,
      expiresIn: 3600,
      expiresAtMs: 3601000,
    };

    const encoded = encodeStoredToken(token);
    const decoded = decodeStoredToken(encoded);
    expect(Option.isSome(decoded)).toBe(true);
    if (Option.isSome(decoded)) {
      expect(decoded.value.accessToken).toBe('token-123');
    }

    const invalid = decodeStoredToken('not-json');
    expect(Option.isNone(invalid)).toBe(true);
  });

  it('detects expired tokens with leeway', () => {
    const now = 200_000;
    const validToken = {
      accessToken: 'token-123',
      tokenType: 'Bearer',
      scope: 'api',
      createdAt: 1000,
      expiresIn: 3600,
      expiresAtMs: now + 120_000,
    };
    expect(isTokenExpired(validToken, now)).toBe(false);

    const expiredToken = {
      ...validToken,
      expiresAtMs: now + 30_000, // within 60s leeway
    };
    expect(isTokenExpired(expiredToken, now)).toBe(true);
  });

  it.effect('returns current access token when not expired', () =>
    Effect.gen(function* () {
      const session = yield* Session;
      yield* session.setToken({
        accessToken: 'valid-token',
        tokenType: 'Bearer',
        scope: 'api',
        createdAt: 1000,
        expiresIn: 3600,
      });

      const token = yield* session.getValidAccessToken();
      expect(token).toBe('valid-token');
    }).pipe(Effect.provide(sessionTestLayer)),
  );

  it.effect('refreshes token when expired', () =>
    Effect.gen(function* () {
      const session = yield* Session;
      yield* session.setToken({
        accessToken: 'old-token',
        tokenType: 'Bearer',
        refreshToken: 'refresh-123',
        scope: 'api',
        createdAt: 1000,
        expiresIn: 3600,
      });
      // Force token to be expired in storage using Clock
      const now = yield* Clock.currentTimeMillis;
      const raw = localStorage.getItem('codetinder_gitlab_oauth')!;
      const parsed = JSON.parse(raw);
      localStorage.setItem(
        'codetinder_gitlab_oauth',
        JSON.stringify({ ...parsed, expiresAtMs: now - 1000 }),
      );

      const token = yield* session.getValidAccessToken();
      expect(token).toBe('new-refreshed-token');
    }).pipe(Effect.provide(sessionTestLayer)),
  );

  it.effect('concurrent getValidAccessToken refreshes token only once (Web Locks protected)', () =>
    Effect.gen(function* () {
      let refreshCount = 0;
      const trackingOAuthLayer = Layer.succeed(
        GitLabOAuth,
        GitLabOAuth.of({
          buildAuthorizeUrl: () => '...',
          exchangeCode: () => Effect.die(new Error('not called')),
          refreshToken: () =>
            Effect.sync(() => {
              refreshCount++;
              return {
                accessToken: `refreshed-${refreshCount}`,
                tokenType: 'Bearer',
                refreshToken: `refresh-${refreshCount}`,
                scope: 'api',
                createdAt: 1000,
                expiresIn: 7200,
              };
            }),
        }),
      );

      const customSessionLayer = Session.layer.pipe(Layer.provide(trackingOAuthLayer));

      yield* Effect.gen(function* () {
        const session = yield* Session;
        yield* session.setToken({
          accessToken: 'initial-expired-token',
          tokenType: 'Bearer',
          refreshToken: 'old-refresh',
          scope: 'api',
          createdAt: 1000,
          expiresIn: 3600,
        });

        const now = yield* Clock.currentTimeMillis;
        const raw = localStorage.getItem('codetinder_gitlab_oauth')!;
        const parsed = JSON.parse(raw);
        localStorage.setItem(
          'codetinder_gitlab_oauth',
          JSON.stringify({ ...parsed, expiresAtMs: now - 1000 }),
        );

        // Run 3 concurrent calls
        const [token1, token2, token3] = yield* Effect.all(
          [
            session.getValidAccessToken(),
            session.getValidAccessToken(),
            session.getValidAccessToken(),
          ],
          { concurrency: 'unbounded' },
        );

        expect(token1).toBe('refreshed-1');
        expect(token2).toBe('refreshed-1');
        expect(token3).toBe('refreshed-1');
        expect(refreshCount).toBe(1);
      }).pipe(Effect.provide(customSessionLayer));
    }),
  );

  it.effect('uses token refreshed by another tab while waiting for lock', () =>
    Effect.gen(function* () {
      let refreshCalled = false;
      const trackingOAuthLayer = Layer.succeed(
        GitLabOAuth,
        GitLabOAuth.of({
          buildAuthorizeUrl: () => '...',
          exchangeCode: () => Effect.die(new Error('not called')),
          refreshToken: () =>
            Effect.sync(() => {
              refreshCalled = true;
              return {
                accessToken: 'refresh-should-not-be-called',
                tokenType: 'Bearer',
                scope: 'api',
                createdAt: 1000,
                expiresIn: 7200,
              };
            }),
        }),
      );

      let requestLockCallCount = 0;
      Object.defineProperty(globalThis, 'navigator', {
        value: {
          locks: {
            request: async (_name: string, callback: () => Promise<unknown>) => {
              requestLockCallCount++;
              // Simulate another tab refreshing and writing to storage before our lock body executes
              const freshToken: StoredToken = {
                accessToken: 'token-from-other-tab',
                tokenType: 'Bearer',
                scope: 'api',
                createdAt: 1000,
                expiresIn: 7200,
                expiresAtMs: 500_000, // Valid
              };
              localStorage.setItem('codetinder_gitlab_oauth', encodeStoredToken(freshToken));
              return callback();
            },
          },
        },
        writable: true,
        configurable: true,
      });

      const customSessionLayer = Session.layer.pipe(Layer.provide(trackingOAuthLayer));

      yield* Effect.gen(function* () {
        const session = yield* Session;
        const now = yield* Clock.currentTimeMillis;
        const expiredToken: StoredToken = {
          accessToken: 'old-expired-token',
          tokenType: 'Bearer',
          refreshToken: 'refresh-old',
          scope: 'api',
          createdAt: 1000,
          expiresIn: 3600,
          expiresAtMs: now - 1000,
        };
        localStorage.setItem('codetinder_gitlab_oauth', encodeStoredToken(expiredToken));

        const token = yield* session.getValidAccessToken();
        expect(token).toBe('token-from-other-tab');
        expect(refreshCalled).toBe(false);
        expect(requestLockCallCount).toBe(1);
      }).pipe(Effect.provide(customSessionLayer));
    }),
  );

  it.effect('completes sign-in on valid code and state', () =>
    Effect.gen(function* () {
      sessionStorage.setItem('oauth_state', 'expected-state');
      sessionStorage.setItem('oauth_code_verifier', 'verifier-123');
      sessionStorage.setItem('oauth_return_to', '/rounds/test-round');

      const returnTo = yield* completeSignIn({
        code: 'auth-code',
        state: 'expected-state',
      });

      expect(returnTo).toBe('/rounds/test-round');
      expect(sessionStorage.getItem('oauth_state')).toBeNull();
      expect(sessionStorage.getItem('oauth_code_verifier')).toBeNull();
    }).pipe(Effect.provide(Session.layer.pipe(Layer.provideMerge(mockOAuthLayer)))),
  );

  it.effect('fails with typed SignInFailed on state mismatch', () =>
    Effect.gen(function* () {
      sessionStorage.setItem('oauth_state', 'expected-state');
      sessionStorage.setItem('oauth_code_verifier', 'verifier-123');

      const error = yield* Effect.flip(
        completeSignIn({
          code: 'auth-code',
          state: 'wrong-state',
        }),
      );

      expect(error).toBeInstanceOf(SignInFailed);
      expect(error.message).toBe('OAuth state mismatch');
    }).pipe(Effect.provide(Session.layer.pipe(Layer.provideMerge(mockOAuthLayer)))),
  );

  it('exported authCallbackAtom across mount -> unmount -> remount exchanges code only once', async () => {
    let exchangeCount = 0;
    const trackingOAuth = GitLabOAuth.of({
      buildAuthorizeUrl: () => '...',
      exchangeCode: () =>
        Effect.sync(() => {
          exchangeCount++;
          return {
            accessToken: 'exchanged-token',
            tokenType: 'Bearer',
            refreshToken: 'exchanged-refresh',
            scope: 'api',
            createdAt: 1000,
            expiresIn: 7200,
          };
        }),
      refreshToken: () => Effect.die(new Error('not called')),
    });

    const testLayer = Session.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.succeed(GitLabOAuth, trackingOAuth),
          GitLabProjects.layer,
          FetchHttpClient.layer,
        ),
      ),
    );

    sessionStorage.setItem('oauth_state', 'test-state');
    sessionStorage.setItem('oauth_code_verifier', 'test-verifier');
    sessionStorage.setItem('oauth_return_to', '/rounds/round-123');

    const registry = AtomRegistry.make({
      initialValues: [[webRuntime.layer, testLayer]],
    });

    const key = 'test-code:test-state';
    const atom = authCallbackAtom(key);

    // Mount
    const unmount1 = registry.mount(atom);

    await new Promise<void>(resolve => {
      let unsub: (() => void) | undefined;
      let resolved = false;
      const sub = registry.subscribe(
        atom,
        res => {
          if (!AsyncResult.isInitial(res) && !resolved) {
            resolved = true;
            unsub?.();
            resolve();
          }
        },
        { immediate: true },
      );
      unsub = sub;
      if (resolved) {
        unsub();
      }
    });

    expect(exchangeCount).toBe(1);

    // Unmount
    unmount1();

    // Remount
    const unmount2 = registry.mount(atom);
    const result = registry.get(atom);
    expect(AsyncResult.isSuccess(result)).toBe(true);
    if (AsyncResult.isSuccess(result)) {
      expect(result.value).toBe('/rounds/round-123');
    }
    expect(exchangeCount).toBe(1);

    unmount2();
  });
});
