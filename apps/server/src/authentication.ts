import { Authentication, CurrentCaller, tokenKind, Unauthorized } from '@codetinder/api';
import { GitLabIdTokens, GitLabUsers, type InvalidToken } from '@codetinder/gitlab';
import * as Cache from 'effect/Cache';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

const CACHE_TTL = '60 seconds';
const CACHE_CAPACITY = 256;

type GitLabUser = { readonly userId: number; readonly username: string };

/**
 * GitLab's answers about a developer, kept for a minute so a burst of swipes asks GitLab once.
 * Only an answer is kept: a failure is asked again. Keys compare by value (`Equal` is structural
 * for plain objects, and `Redacted` compares its secret), so an identical lookup hits the cache.
 */
export class CachedGitLabUsers extends Context.Service<
  CachedGitLabUsers,
  {
    readonly whoAmI: (token: Redacted.Redacted<string>) => Effect.Effect<GitLabUser, InvalidToken>;
    readonly canReadCode: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => Effect.Effect<boolean>;
    readonly canPush: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly userId: number;
    }) => Effect.Effect<boolean>;
  }
>()('@codetinder/server/CachedGitLabUsers') {
  static readonly layer = Layer.effect(
    CachedGitLabUsers,
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const timeToLive = <A, E>(exit: Exit.Exit<A, E>) =>
        Exit.isFailure(exit) ? Duration.zero : CACHE_TTL;
      const whoAmI = yield* Cache.makeWith(users.whoAmI, {
        capacity: CACHE_CAPACITY,
        timeToLive,
      });
      const canReadCode = yield* Cache.makeWith(users.canReadCode, {
        capacity: CACHE_CAPACITY,
        timeToLive,
      });
      const canPush = yield* Cache.makeWith(users.canPush, {
        capacity: CACHE_CAPACITY,
        timeToLive,
      });
      return CachedGitLabUsers.of({
        whoAmI: token => Cache.get(whoAmI, token),
        canReadCode: access => Cache.get(canReadCode, access),
        canPush: access => Cache.get(canPush, access),
      });
    }),
  );
}

export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const idTokens = yield* GitLabIdTokens;
    const users = yield* CachedGitLabUsers;

    return Authentication.of({
      bearer: Effect.fn('Authentication.bearer')(function* (httpEffect, { credential }) {
        if (Redacted.value(credential) === '') {
          return yield* new Unauthorized({ message: 'missing bearer token' });
        }

        const kind = tokenKind(Redacted.value(credential));
        if (kind === 'id-token') {
          const claims = yield* idTokens
            .verify(credential)
            .pipe(
              Effect.mapError(() => new Unauthorized({ message: 'GitLab ID token is invalid' })),
            );
          return yield* Effect.provideService(httpEffect, CurrentCaller, {
            _tag: 'Flow',
            projectId: claims.projectId,
            projectPath: claims.projectPath,
          });
        }

        const user = yield* users
          .whoAmI(credential)
          .pipe(
            Effect.mapError(() => new Unauthorized({ message: 'GitLab OAuth token is invalid' })),
          );
        return yield* Effect.provideService(httpEffect, CurrentCaller, {
          _tag: 'Developer',
          userId: user.userId,
          username: user.username,
          token: credential,
        });
      }),
    });
  }),
);
