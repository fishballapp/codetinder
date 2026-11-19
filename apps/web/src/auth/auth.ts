import {
  deriveCodeChallenge,
  GitLabOAuth,
  type GitLabOAuthToken,
  generateCodeVerifier,
  generateState,
} from '@codetinder/gitlab';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { GITLAB_OAUTH_CLIENT_ID, getOAuthRedirectUri } from '../config';

const STORAGE_KEY = 'codetinder_gitlab_oauth';
const SESSION_STATE_KEY = 'oauth_state';
const SESSION_VERIFIER_KEY = 'oauth_code_verifier';
const SESSION_RETURN_KEY = 'oauth_return_to';

export class SignInFailed extends Schema.TaggedError<SignInFailed>()('SignInFailed', {
  message: Schema.String,
}) {}

export class SignedOut extends Schema.TaggedError<SignedOut>()('SignedOut', {
  message: Schema.String,
}) {}

export const StoredTokenSchema = Schema.Struct({
  accessToken: Schema.String,
  tokenType: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  scope: Schema.String,
  createdAt: Schema.Number,
  expiresIn: Schema.Number,
  expiresAtMs: Schema.Number,
});

export type StoredToken = typeof StoredTokenSchema.Type;

const StoredTokenJsonSchema = Schema.fromJsonString(StoredTokenSchema);
export const decodeStoredToken = Schema.decodeUnknownOption(StoredTokenJsonSchema);
export const encodeStoredToken = Schema.encodeSync(StoredTokenJsonSchema);

export const isTokenExpired = (token: StoredToken, nowMs: number, leewayMs = 60_000): boolean =>
  token.expiresAtMs - nowMs <= leewayMs;

export const tokenToStored = (token: GitLabOAuthToken, nowMs: number): StoredToken => ({
  accessToken: token.accessToken,
  tokenType: token.tokenType,
  ...(token.refreshToken !== undefined ? { refreshToken: token.refreshToken } : {}),
  scope: token.scope,
  createdAt: token.createdAt,
  expiresIn: token.expiresIn,
  expiresAtMs: nowMs + token.expiresIn * 1000,
});

const acquireWebLock = (name: string): Effect.Effect<() => void> =>
  Effect.callback<() => void>(resume => {
    navigator.locks
      .request(
        name,
        () =>
          new Promise<void>(release => {
            resume(Effect.succeed(release));
          }),
      )
      .catch(err => {
        resume(Effect.die(err));
      });
  });

/**
 * Runs a step that consumes a GitLab credential (an authorization code, a refresh token) to the
 * end even if its caller goes away: once GitLab answers, the old credential is spent, so the answer
 * must be stored. The step keeps its own timeout.
 */
const runToCompletion = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.forkDetach(effect).pipe(Effect.flatMap(Fiber.join));

/** One refresh at a time across every tab: GitLab rotates the refresh token on each use. */
const withRefreshLock = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    acquireWebLock('codetinder-token-refresh'),
    () => effect,
    release => Effect.sync(() => release()),
  );

export class Session extends Context.Service<
  Session,
  {
    readonly getValidAccessToken: () => Effect.Effect<string | null>;
    readonly setToken: (token: GitLabOAuthToken) => Effect.Effect<void>;
    readonly clearToken: () => Effect.Effect<void>;
  }
>()('@codetinder/web/Session') {
  static readonly layer = Layer.effect(
    Session,
    Effect.gen(function* () {
      const oauth = yield* GitLabOAuth;

      const readStored = (): Option.Option<StoredToken> => {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null) return Option.none();
        return decodeStoredToken(raw);
      };

      const writeStored = (token: StoredToken): void => {
        localStorage.setItem(STORAGE_KEY, encodeStoredToken(token));
      };

      const removeStored = (): void => {
        localStorage.removeItem(STORAGE_KEY);
      };

      const refreshAndPersist = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Another tab may have refreshed while this one waited for the lock.
        const latest = readStored();
        if (Option.isNone(latest)) {
          return null;
        }
        if (!isTokenExpired(latest.value, now)) {
          return latest.value.accessToken;
        }
        if (!latest.value.refreshToken) {
          removeStored();
          return null;
        }

        const refreshed = yield* oauth
          .refreshToken({
            clientId: GITLAB_OAUTH_CLIENT_ID,
            refreshToken: latest.value.refreshToken,
          })
          .pipe(
            Effect.catchTag('OAuthError', () => {
              removeStored();
              return Effect.succeed(null);
            }),
          );

        if (!refreshed) {
          return null;
        }

        const stored = tokenToStored(refreshed, now);
        writeStored(stored);
        return stored.accessToken;
      });

      const getValidAccessToken = Effect.fn('Session.getValidAccessToken')(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = readStored();
        if (Option.isNone(current)) {
          return null;
        }
        if (!isTokenExpired(current.value, now)) {
          return current.value.accessToken;
        }

        return yield* runToCompletion(withRefreshLock(refreshAndPersist));
      });

      const setToken = Effect.fn('Session.setToken')((token: GitLabOAuthToken) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          writeStored(tokenToStored(token, now));
        }),
      );

      const clearToken = Effect.fn('Session.clearToken')(() =>
        Effect.sync(() => {
          removeStored();
        }),
      );

      return Session.of({
        getValidAccessToken,
        setToken,
        clearToken,
      });
    }),
  );
}

export const startSignIn = (
  returnTo: string = window.location.pathname + window.location.search,
): Effect.Effect<void, never, GitLabOAuth> =>
  Effect.gen(function* () {
    const verifier = generateCodeVerifier();
    const state = generateState();

    sessionStorage.setItem(SESSION_VERIFIER_KEY, verifier);
    sessionStorage.setItem(SESSION_STATE_KEY, state);
    sessionStorage.setItem(SESSION_RETURN_KEY, returnTo);

    const challenge = yield* deriveCodeChallenge(verifier);
    const oauth = yield* GitLabOAuth;
    const url = oauth.buildAuthorizeUrl({
      clientId: GITLAB_OAUTH_CLIENT_ID,
      redirectUri: getOAuthRedirectUri(),
      state,
      codeChallenge: challenge,
      scope: 'api',
    });

    window.location.href = url;
  });

export const completeSignIn = (args: {
  readonly code: string;
  readonly state: string;
}): Effect.Effect<string, SignInFailed, GitLabOAuth | Session> =>
  Effect.gen(function* () {
    if (!args.code || !args.state) {
      return yield* new SignInFailed({
        message: 'Missing code or state parameter',
      });
    }

    const savedState = sessionStorage.getItem(SESSION_STATE_KEY);
    if (!savedState || savedState !== args.state) {
      return yield* new SignInFailed({ message: 'OAuth state mismatch' });
    }

    const codeVerifier = sessionStorage.getItem(SESSION_VERIFIER_KEY);
    if (!codeVerifier) {
      return yield* new SignInFailed({ message: 'Missing OAuth code verifier' });
    }

    const oauth = yield* GitLabOAuth;
    const session = yield* Session;

    const returnTo = yield* runToCompletion(
      Effect.gen(function* () {
        const token = yield* oauth
          .exchangeCode({
            clientId: GITLAB_OAUTH_CLIENT_ID,
            redirectUri: getOAuthRedirectUri(),
            code: args.code,
            codeVerifier,
          })
          .pipe(Effect.catchTag('OAuthError', err => new SignInFailed({ message: err.message })));

        yield* session.setToken(token);

        sessionStorage.removeItem(SESSION_STATE_KEY);
        sessionStorage.removeItem(SESSION_VERIFIER_KEY);

        const target = sessionStorage.getItem(SESSION_RETURN_KEY) ?? '/';
        sessionStorage.removeItem(SESSION_RETURN_KEY);
        return target;
      }),
    );

    return returnTo;
  });
