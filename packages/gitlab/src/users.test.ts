import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as TestClock from 'effect/testing/TestClock';
import { GITLAB_BASE_URL } from './gitlab';
import { GitLabUsers, InvalidToken } from './users';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withUsers = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabUsers.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

describe('GitLabUsers.whoAmI', () => {
  it.effect('returns the user on 200', () =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const me = yield* users.whoAmI(Redacted.make('oauth-token'));
      expect(me).toEqual({ userId: 42, username: 'ada' });
    }).pipe(
      Effect.provide(
        withUsers(
          scriptedFetch(request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/v4/user`);
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            return new Response(JSON.stringify({ id: 42, username: 'ada' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    ),
  );

  it.effect('fails as InvalidToken on 401', () =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const error = yield* Effect.flip(users.whoAmI(Redacted.make('bad')));
      expect(error._tag).toBe('InvalidToken');
      expect(error.message).toMatch(/rejected/);
    }).pipe(Effect.provide(withUsers(scriptedFetch(() => new Response('', { status: 401 }))))),
  );
});

describe('GitLabUsers.whoAmI failures', () => {
  it.effect('fails as InvalidToken on 403, a token without the scope', () =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const error = yield* Effect.flip(users.whoAmI(Redacted.make('scopeless')));
      expect(error).toBeInstanceOf(InvalidToken);
    }).pipe(Effect.provide(withUsers(scriptedFetch(() => new Response('', { status: 403 }))))),
  );

  it.effect('dies when GitLab answers no attempt within 26 seconds', () =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const fiber = yield* Effect.forkChild(
        Effect.exit(users.whoAmI(Redacted.make('oauth-token'))),
      );
      yield* TestClock.adjust('26 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(Effect.provide(withUsers(scriptedFetch(() => new Promise<Response>(() => {}))))),
  );
});

describe('GitLabUsers.whoAmI retries', () => {
  it.effect('answers once GitLab recovers from a slow attempt', () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const fiber = yield* Effect.forkChild(users.whoAmI(Redacted.make('oauth-token')));
      yield* TestClock.adjust('9 seconds');
      const me = yield* Fiber.join(fiber);
      expect(me).toEqual({ userId: 42, username: 'ada' });
      expect(attempts).toBe(2);
    }).pipe(
      Effect.provide(
        withUsers(
          scriptedFetch(() => {
            attempts += 1;
            return attempts === 1
              ? new Promise<Response>(() => {})
              : new Response(JSON.stringify({ id: 42, username: 'ada' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                });
          }),
        ),
      ),
    );
  });
});

describe('GitLabUsers.canReadCode', () => {
  const check = (status: number) =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      return yield* users.canReadCode({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
      });
    }).pipe(
      Effect.provide(
        withUsers(
          scriptedFetch(request => {
            expect(request.url).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/87434709/repository/tree?per_page=1`,
            );
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            return new Response('', { status });
          }),
        ),
      ),
    );

  it.effect('is true on 200', () =>
    Effect.gen(function* () {
      expect(yield* check(200)).toBe(true);
    }),
  );

  it.effect('is false on 401, 403 and 404', () =>
    Effect.gen(function* () {
      expect(yield* check(401)).toBe(false);
      expect(yield* check(403)).toBe(false);
      expect(yield* check(404)).toBe(false);
    }),
  );

  it.effect('dies on any other status', () =>
    Effect.gen(function* () {
      expect(Exit.hasDies(yield* Effect.exit(check(400)))).toBe(true);
    }),
  );

  it.effect('is not granted by the project endpoint alone', () =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      const access = yield* users.canReadCode({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
      });
      expect(access).toBe(false);
    }).pipe(
      Effect.provide(
        withUsers(
          scriptedFetch(request =>
            request.url.endsWith('/repository/tree?per_page=1')
              ? new Response('', { status: 403 })
              : new Response('{}', { status: 200 }),
          ),
        ),
      ),
    ),
  );
});

describe('GitLabUsers.canPush', () => {
  const member = (accessLevel: number) =>
    new Response(JSON.stringify({ id: 42, username: 'ada', access_level: accessLevel }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  const check = (respond: () => Response) =>
    Effect.gen(function* () {
      const users = yield* GitLabUsers;
      return yield* users.canPush({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        userId: 42,
      });
    }).pipe(
      Effect.provide(
        withUsers(
          scriptedFetch(request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/v4/projects/87434709/members/all/42`);
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            return respond();
          }),
        ),
      ),
    );

  it.effect('is true for a Developer or above', () =>
    Effect.gen(function* () {
      expect(yield* check(() => member(30))).toBe(true);
      expect(yield* check(() => member(40))).toBe(true);
    }),
  );

  it.effect('is true for a Developer whose role is inherited from an ancestor group', () =>
    // members/all lists inherited members with their effective level, so the same answer
    // as a direct member; the project's own permissions would have said no access at all.
    Effect.gen(function* () {
      expect(yield* check(() => member(30))).toBe(true);
    }),
  );

  it.effect('is false below Developer', () =>
    Effect.gen(function* () {
      expect(yield* check(() => member(20))).toBe(false);
    }),
  );

  it.effect('is false when not a member, and on 401 and 403', () =>
    Effect.gen(function* () {
      for (const status of [401, 403, 404]) {
        expect(yield* check(() => new Response('', { status }))).toBe(false);
      }
    }),
  );

  it.effect('dies on any other status', () =>
    Effect.gen(function* () {
      expect(Exit.hasDies(yield* Effect.exit(check(() => new Response('', { status: 400 }))))).toBe(
        true,
      );
    }),
  );
});
