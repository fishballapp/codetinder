import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GITLAB_BASE_URL } from './gitlab';
import { GitLabSetup, SETUP_BRANCH, SETUP_TITLE, SetupFilesExist } from './setup';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withSetup = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabSetup.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

describe('GitLabSetup.defaultBranch', () => {
  it.effect('returns default branch from project details', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const branch = yield* setup.defaultBranch({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
      });
      expect(branch).toBe('main');
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/v4/projects/87434709`);
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            return new Response(JSON.stringify({ default_branch: 'main' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    ),
  );
});

describe('GitLabSetup.branchHead', () => {
  it.effect('answers the commit the branch points at', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const head = yield* setup.branchHead({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        branch: 'release/1.0',
      });
      expect(head).toBe('abc123');
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            expect(request.url).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/87434709/repository/branches/release%2F1.0`,
            );
            return new Response(JSON.stringify({ commit: { id: 'abc123' } }), { status: 200 });
          }),
        ),
      ),
    ),
  );
});

describe('GitLabSetup.rootFileNames', () => {
  it.effect('lists root files from repository tree on specified ref', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const files = yield* setup.rootFileNames({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        ref: 'main',
      });
      expect(files).toEqual(['package.json', 'pnpm-lock.yaml', 'src']);
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            expect(request.url).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/87434709/repository/tree?per_page=100&page=1&ref=main`,
            );
            return new Response(
              JSON.stringify([
                { name: 'package.json' },
                { name: 'pnpm-lock.yaml' },
                { name: 'src' },
              ]),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('follows pagination until the last page with lockfile on page two', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const files = yield* setup.rootFileNames({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        ref: 'main',
      });
      expect(files).toEqual(['README.md', 'package.json', 'pnpm-lock.yaml']);
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            const url = new URL(request.url);
            expect(url.pathname).toBe('/api/v4/projects/87434709/repository/tree');
            expect(url.searchParams.get('per_page')).toBe('100');
            expect(url.searchParams.get('ref')).toBe('main');

            if (url.searchParams.get('page') === '2') {
              return new Response(JSON.stringify([{ name: 'pnpm-lock.yaml' }]), {
                status: 200,
                headers: {
                  'content-type': 'application/json',
                  'x-next-page': '',
                },
              });
            }

            expect(url.searchParams.get('page')).toBe('1');
            return new Response(JSON.stringify([{ name: 'README.md' }, { name: 'package.json' }]), {
              status: 200,
              headers: {
                'content-type': 'application/json',
                'x-next-page': '2',
              },
            });
          }),
        ),
      ),
    ),
  );
});

describe('GitLabSetup.openSetupMergeRequest', () => {
  const files = [
    { path: '.codetinder/config.json', action: 'create', content: '{}' },
    { path: '.codetinder/principles.md', action: 'create', content: '' },
    { path: 'AGENTS.md', action: 'update', content: '# Agents\n' },
  ] as const;

  it.effect('creates commit and merge request returning web url', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const url = yield* setup.openSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        defaultBranch: 'main',
        baseSha: 'base-sha',
        files,
        description: 'MR description',
      });
      expect(url).toBe('https://gitlab.com/project/-/merge_requests/1');
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            if (request.url.endsWith('/repository/commits')) {
              const body = await request.json();
              expect(body.branch).toBe(SETUP_BRANCH);
              expect(body.start_sha).toBe('base-sha');
              expect(body.commit_message).toBe(SETUP_TITLE);
              expect(body.actions).toEqual([
                { action: 'create', file_path: '.codetinder/config.json', content: '{}' },
                { action: 'create', file_path: '.codetinder/principles.md', content: '' },
                { action: 'update', file_path: 'AGENTS.md', content: '# Agents\n' },
              ]);
              return new Response(JSON.stringify({ id: 'commit-sha' }), { status: 201 });
            }
            if (request.url.endsWith('/merge_requests')) {
              const body = await request.json();
              expect(body.source_branch).toBe(SETUP_BRANCH);
              expect(body.target_branch).toBe('main');
              expect(body.title).toBe(SETUP_TITLE);
              expect(body.description).toBe('MR description');
              expect(body.remove_source_branch).toBe(true);
              return new Response(
                JSON.stringify({
                  web_url: 'https://gitlab.com/project/-/merge_requests/1',
                  source_project_id: 87434709,
                }),
                { status: 201, headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response('Not Found', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('finds and returns existing open MR if branch already exists and MR is open', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const url = yield* setup.openSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        defaultBranch: 'main',
        baseSha: 'base-sha',
        files,
        description: 'MR description',
      });
      expect(url).toBe('https://gitlab.com/project/-/merge_requests/42');
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            if (request.url.endsWith('/repository/commits')) {
              return new Response(
                JSON.stringify({ message: "A branch called 'codetinder/setup' already exists" }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              );
            }
            if (request.url.includes('/merge_requests')) {
              const url = new URL(request.url);
              expect(url.searchParams.get('source_branch')).toBe(SETUP_BRANCH);
              expect(url.searchParams.get('state')).toBe('opened');
              return new Response(
                JSON.stringify([
                  {
                    web_url: 'https://gitlab.com/project/-/merge_requests/42',
                    source_project_id: 87434709,
                  },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response('Not Found', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('replaces a leftover setup branch with no open MR, then opens the MR', () => {
    const calls: string[] = [];
    let commits = 0;
    return Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const url = yield* setup.openSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        defaultBranch: 'main',
        baseSha: 'base-sha',
        files,
        description: 'MR description',
      });
      expect(url).toBe('https://gitlab.com/group/project/-/merge_requests/9');
      expect(calls).toEqual([
        'POST /repository/commits',
        'GET /merge_requests',
        'DELETE /repository/branches/codetinder%2Fsetup',
        'POST /repository/commits',
        'POST /merge_requests',
      ]);
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            const path = new URL(request.url).pathname.replace('/api/v4/projects/87434709', '');
            calls.push(`${request.method} ${path}`);
            const json = (body: unknown, status: number) =>
              new Response(JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json' },
              });
            if (path === '/repository/commits') {
              commits += 1;
              return commits === 1
                ? json({ message: "A branch called 'codetinder/setup' already exists" }, 400)
                : json({ id: 'abc' }, 201);
            }
            if (path === '/merge_requests' && request.method === 'GET') {
              // A fork's MR from a branch of the same name: not CodeTinder's.
              return json(
                [
                  {
                    web_url: 'https://gitlab.com/fork/project/-/merge_requests/3',
                    source_project_id: 1,
                  },
                ],
                200,
              );
            }
            if (path.startsWith('/repository/branches/')) {
              return new Response(null, { status: 204 });
            }
            if (path === '/merge_requests') {
              return json(
                {
                  web_url: 'https://gitlab.com/group/project/-/merge_requests/9',
                  source_project_id: 87434709,
                },
                201,
              );
            }
            return new Response('Not Found', { status: 404 });
          }),
        ),
      ),
    );
  });

  it.effect(
    'fails with SetupFilesExist if commit returns 400 with file already exists message',
    () =>
      Effect.gen(function* () {
        const setup = yield* GitLabSetup;
        const error = yield* Effect.flip(
          setup.openSetupMergeRequest({
            token: Redacted.make('oauth-token'),
            projectId: '87434709',
            defaultBranch: 'main',
            baseSha: 'base-sha',
            files,
            description: 'MR description',
          }),
        );
        expect(error).toBeInstanceOf(SetupFilesExist);
        expect(error.message).toBe('A file with this name already exists');
      }).pipe(
        Effect.provide(
          withSetup(
            scriptedFetch(async request => {
              if (request.url.endsWith('/repository/commits')) {
                return new Response(
                  JSON.stringify({ message: 'A file with this name already exists' }),
                  { status: 400, headers: { 'content-type': 'application/json' } },
                );
              }
              return new Response('Not Found', { status: 404 });
            }),
          ),
        ),
      ),
  );

  it.effect('dies when commit returns 400 with unexpected message', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const exit = yield* Effect.exit(
        setup.openSetupMergeRequest({
          token: Redacted.make('oauth-token'),
          projectId: '87434709',
          defaultBranch: 'main',
          baseSha: 'base-sha',
          files,
          description: 'MR description',
        }),
      );
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            if (request.url.endsWith('/repository/commits')) {
              return new Response(
                JSON.stringify({ message: 'Something completely unexpected broke' }),
                { status: 400, headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response('Not Found', { status: 404 });
          }),
        ),
      ),
    ),
  );

  it.effect('handles 409 conflict when opening MR by finding existing open MR', () =>
    Effect.gen(function* () {
      const setup = yield* GitLabSetup;
      const url = yield* setup.openSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
        defaultBranch: 'main',
        baseSha: 'base-sha',
        files,
        description: 'MR description',
      });
      expect(url).toBe('https://gitlab.com/project/-/merge_requests/99');
    }).pipe(
      Effect.provide(
        withSetup(
          scriptedFetch(async request => {
            if (request.url.endsWith('/repository/commits')) {
              return new Response(JSON.stringify({ id: 'commit-sha' }), { status: 201 });
            }
            if (request.url.endsWith('/merge_requests') && request.method === 'POST') {
              return new Response(JSON.stringify({ message: ['Another MR already exists'] }), {
                status: 409,
              });
            }
            if (request.url.includes('/merge_requests') && request.method === 'GET') {
              return new Response(
                JSON.stringify([
                  {
                    web_url: 'https://gitlab.com/project/-/merge_requests/99',
                    source_project_id: 87434709,
                  },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
              );
            }
            return new Response('Not Found', { status: 404 });
          }),
        ),
      ),
    ),
  );
});
