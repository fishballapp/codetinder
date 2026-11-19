import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { GitLabCommits } from './commits';
import { GITLAB_BASE_URL, GitLabRequestFailed } from './gitlab';

const withConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ GITLAB_TOKEN: 'test-gitlab-token' }),
);

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withCommits = (fetch: typeof globalThis.fetch) =>
  GitLabCommits.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    Layer.provide(withConfig),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('GitLabCommits.commit', () => {
  it.effect('commits every file as an action on the branch, returning the commit', () =>
    Effect.gen(function* () {
      const commits = yield* GitLabCommits;
      const commit = yield* commits.commit({
        projectId: '42',
        branch: 'codetinder/learn-1',
        message: 'learn: principles',
        files: [
          { path: 'docs/principles.md', content: '# Principles', action: 'create' },
          { path: 'src/a.ts', content: 'export {};', action: 'update', lastCommitId: 'f00d' },
        ],
      });
      expect(commit).toEqual({
        id: 'abc123',
        webUrl: 'https://gitlab.com/group/demo/-/commit/abc123',
      });
    }).pipe(
      Effect.provide(
        withCommits(
          scriptedFetch(async request => {
            expect(request.method).toBe('POST');
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/v4/projects/42/repository/commits`);
            expect(request.headers.get('authorization')).toBe('Bearer test-gitlab-token');
            expect(await request.json()).toEqual({
              branch: 'codetinder/learn-1',
              commit_message: 'learn: principles',
              actions: [
                { action: 'create', file_path: 'docs/principles.md', content: '# Principles' },
                {
                  action: 'update',
                  file_path: 'src/a.ts',
                  content: 'export {};',
                  last_commit_id: 'f00d',
                },
              ],
            });
            return json(
              { id: 'abc123', web_url: 'https://gitlab.com/group/demo/-/commit/abc123' },
              201,
            );
          }),
        ),
      ),
    ),
  );

  it.effect('creates the branch from startSha when given', () =>
    Effect.gen(function* () {
      const commits = yield* GitLabCommits;
      yield* commits.commit({
        projectId: '42',
        branch: 'codetinder/learn-1',
        startSha: 'deadbeef',
        message: 'learn',
        files: [],
      });
    }).pipe(
      Effect.provide(
        withCommits(
          scriptedFetch(async request => {
            expect(await request.json()).toMatchObject({
              branch: 'codetinder/learn-1',
              start_sha: 'deadbeef',
            });
            return json({ id: 'abc123', web_url: 'x' }, 201);
          }),
        ),
      ),
    ),
  );

  it.effect('omits start_sha when committing onto an existing branch', () =>
    Effect.gen(function* () {
      const commits = yield* GitLabCommits;
      yield* commits.commit({
        projectId: '42',
        branch: 'feat/x',
        message: 'learn',
        files: [],
      });
    }).pipe(
      Effect.provide(
        withCommits(
          scriptedFetch(async request => {
            const body: Record<string, unknown> = await request.json();
            expect(body).not.toHaveProperty('start_sha');
            return json({ id: 'abc123', web_url: 'x' }, 201);
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabRequestFailed on 403', () =>
    Effect.gen(function* () {
      const commits = yield* GitLabCommits;
      const error = yield* Effect.flip(
        commits.commit({ projectId: '42', branch: 'feat/x', message: 'm', files: [] }),
      );
      expect(error).toBeInstanceOf(GitLabRequestFailed);
      expect(error.status).toBe(403);
    }).pipe(Effect.provide(withCommits(scriptedFetch(() => new Response('', { status: 403 }))))),
  );
});
