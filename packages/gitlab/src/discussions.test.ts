import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GitLabDiscussions } from './discussions';
import { GITLAB_BASE_URL } from './gitlab';
import { InvalidToken } from './users';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withDiscussions = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabDiscussions.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const discussionFixture = {
  id: 'abc123',
  notes: [
    {
      id: 501,
      body: 'Why this shape?',
      author: { username: 'reviewer' },
      system: false,
    },
    {
      id: 502,
      body: 'added 1 commit',
      author: { username: 'gitlab-bot' },
      system: true,
    },
  ],
};

describe('GitLabDiscussions.list', () => {
  it.effect('returns every discussion with its notes, mapped to the domain shape', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const result = yield* discussions.list({
        token: Redacted.make('oauth-token'),
        projectId: '42',
        mergeRequestIid: 7,
      });
      expect(result).toEqual([
        {
          id: 'abc123',
          notes: [
            { id: 501, body: 'Why this shape?', authorUsername: 'reviewer', isSystem: false },
            { id: 502, body: 'added 1 commit', authorUsername: 'gitlab-bot', isSystem: true },
          ],
        },
      ]);
    }).pipe(
      Effect.provide(
        withDiscussions(
          scriptedFetch(request => {
            const url = new URL(request.url);
            expect(url.origin + url.pathname).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/42/merge_requests/7/discussions`,
            );
            expect(url.searchParams.get('per_page')).toBe('100');
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            return json([discussionFixture]);
          }),
        ),
      ),
    ),
  );

  it.effect('follows X-Next-Page across pages', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const result = yield* discussions.list({
        token: Redacted.make('oauth-token'),
        projectId: '42',
        mergeRequestIid: 7,
      });
      expect(result.map(discussion => discussion.id)).toEqual(['abc123', 'def456']);
    }).pipe(
      Effect.provide(
        withDiscussions(
          scriptedFetch(request => {
            const page = new URL(request.url).searchParams.get('page');
            if (page === '2') {
              return json([{ ...discussionFixture, id: 'def456', notes: [] }]);
            }
            return json([discussionFixture], 200, { 'x-next-page': '2' });
          }),
        ),
      ),
    ),
  );

  it.effect('addresses the project by its URL-encoded id', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      yield* discussions.list({
        token: Redacted.make('oauth-token'),
        projectId: 'group/demo',
        mergeRequestIid: 7,
      });
    }).pipe(
      Effect.provide(
        withDiscussions(
          scriptedFetch(request => {
            expect(request.url.startsWith(`${GITLAB_BASE_URL}/api/v4/projects/group%2Fdemo/`)).toBe(
              true,
            );
            return json([]);
          }),
        ),
      ),
    ),
  );

  it.effect('fails as InvalidToken on 401', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const error = yield* Effect.flip(
        discussions.list({
          token: Redacted.make('bad-token'),
          projectId: '42',
          mergeRequestIid: 7,
        }),
      );
      expect(error).toBeInstanceOf(InvalidToken);
    }).pipe(
      Effect.provide(withDiscussions(scriptedFetch(() => new Response('', { status: 401 })))),
    ),
  );

  it.effect('dies on any other status', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const exit = yield* Effect.exit(
        discussions.list({
          token: Redacted.make('oauth-token'),
          projectId: '42',
          mergeRequestIid: 7,
        }),
      );
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(withDiscussions(scriptedFetch(() => new Response('oops', { status: 400 })))),
    ),
  );
});

describe('GitLabDiscussions.reply', () => {
  it.effect('posts the body to the discussion and answers the new note id', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const result = yield* discussions.reply({
        token: Redacted.make('oauth-token'),
        projectId: '42',
        mergeRequestIid: 7,
        discussionId: 'abc123',
        body: 'Looks right.',
      });
      expect(result).toEqual({ noteId: 777 });
    }).pipe(
      Effect.provide(
        withDiscussions(
          scriptedFetch(async request => {
            const url = new URL(request.url);
            expect(request.method).toBe('POST');
            expect(url.origin + url.pathname).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/42/merge_requests/7/discussions/abc123/notes`,
            );
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            expect(await request.json()).toEqual({ body: 'Looks right.' });
            return json({ id: 777, body: 'Looks right.' }, 201);
          }),
        ),
      ),
    ),
  );

  it.effect('fails as InvalidToken on 403', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const error = yield* Effect.flip(
        discussions.reply({
          token: Redacted.make('scopeless'),
          projectId: '42',
          mergeRequestIid: 7,
          discussionId: 'abc123',
          body: 'hi',
        }),
      );
      expect(error).toBeInstanceOf(InvalidToken);
    }).pipe(
      Effect.provide(withDiscussions(scriptedFetch(() => new Response('', { status: 403 })))),
    ),
  );

  it.effect('dies on any other status', () =>
    Effect.gen(function* () {
      const discussions = yield* GitLabDiscussions;
      const exit = yield* Effect.exit(
        discussions.reply({
          token: Redacted.make('oauth-token'),
          projectId: '42',
          mergeRequestIid: 7,
          discussionId: 'abc123',
          body: 'hi',
        }),
      );
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(withDiscussions(scriptedFetch(() => new Response('oops', { status: 404 })))),
    ),
  );
});
