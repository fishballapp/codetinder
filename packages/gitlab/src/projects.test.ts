import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GITLAB_BASE_URL } from './gitlab';
import { GitLabProjects } from './projects';
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

const withProjects = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabProjects.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

describe('GitLabProjects.listWritable', () => {
  it.effect(
    'returns writable projects, scheduled for deletion ones too, leaving out archived',
    () =>
      Effect.gen(function* () {
        const projects = yield* GitLabProjects;
        const result = yield* projects.listWritable(Redacted.make('oauth-token'));
        expect(result).toEqual([
          { id: 1, name: 'Project Alpha', fullPath: 'group/alpha', defaultBranch: 'main' },
          {
            id: 3,
            name: 'old-deletion_scheduled-3',
            fullPath: 'group/old-deletion_scheduled-3',
            defaultBranch: 'main',
          },
          { id: 2, name: 'Project Beta', fullPath: 'group/beta', defaultBranch: null },
        ]);
      }).pipe(
        Effect.provide(
          withProjects(
            scriptedFetch(request => {
              const url = new URL(request.url);
              expect(url.origin + url.pathname).toBe(`${GITLAB_BASE_URL}/api/v4/projects`);
              expect(url.searchParams.get('min_access_level')).toBe('30');
              expect(url.searchParams.get('archived')).toBe('false');
              expect(url.searchParams.get('membership')).toBe('true');
              expect(url.searchParams.get('per_page')).toBe('100');
              expect(url.searchParams.get('order_by')).toBe('last_activity_at');
              expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
              return new Response(
                JSON.stringify([
                  {
                    id: 1,
                    name: 'Project Alpha',
                    path_with_namespace: 'group/alpha',
                    default_branch: 'main',
                  },
                  {
                    id: 3,
                    name: 'old-deletion_scheduled-3',
                    path_with_namespace: 'group/old-deletion_scheduled-3',
                    default_branch: 'main',
                  },
                  {
                    id: 2,
                    name: 'Project Beta',
                    path_with_namespace: 'group/beta',
                    default_branch: null,
                  },
                ]),
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

  it.effect('follows X-Next-Page across multiple pages', () =>
    Effect.gen(function* () {
      const projects = yield* GitLabProjects;
      const result = yield* projects.listWritable(Redacted.make('oauth-token'));
      expect(result).toEqual([
        { id: 1, name: 'Project Alpha', fullPath: 'group/alpha', defaultBranch: 'main' },
        { id: 2, name: 'Project Beta', fullPath: 'group/beta', defaultBranch: null },
      ]);
    }).pipe(
      Effect.provide(
        withProjects(
          scriptedFetch(request => {
            const url = new URL(request.url);
            const page = url.searchParams.get('page');
            if (page === '1' || page === null) {
              return new Response(
                JSON.stringify([
                  {
                    id: 1,
                    name: 'Project Alpha',
                    path_with_namespace: 'group/alpha',
                    default_branch: 'main',
                  },
                ]),
                {
                  status: 200,
                  headers: {
                    'content-type': 'application/json',
                    'x-next-page': '2',
                  },
                },
              );
            }
            if (page === '2') {
              return new Response(
                JSON.stringify([
                  {
                    id: 2,
                    name: 'Project Beta',
                    path_with_namespace: 'group/beta',
                    default_branch: null,
                  },
                ]),
                {
                  status: 200,
                  headers: {
                    'content-type': 'application/json',
                    'x-next-page': '',
                  },
                },
              );
            }
            return new Response('not found', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('fails as InvalidToken on 401', () =>
    Effect.gen(function* () {
      const projects = yield* GitLabProjects;
      const error = yield* Effect.flip(projects.listWritable(Redacted.make('bad-token')));
      expect(error).toBeInstanceOf(InvalidToken);
    }).pipe(
      Effect.provide(
        withProjects(
          scriptedFetch(
            () =>
              new Response(JSON.stringify({ message: '401 Unauthorized' }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('dies on an unexpected status', () =>
    Effect.gen(function* () {
      const projects = yield* GitLabProjects;
      const exit = yield* Effect.exit(projects.listWritable(Redacted.make('oauth-token')));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withProjects(
          scriptedFetch(
            () =>
              new Response('bad request', {
                status: 400,
              }),
          ),
        ),
      ),
    ),
  );
});
