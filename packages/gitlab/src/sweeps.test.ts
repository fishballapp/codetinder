import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { GitLabRequestFailed } from './gitlab';
import { GitLabSweeps } from './sweeps';

const withConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ GITLAB_TOKEN: 'test-gitlab-token' }),
);

/** GitLab answering `handler` for each request, as the real client sends it. */
const withSweeps = (handler: (url: URL, request: Request) => Response) =>
  GitLabSweeps.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        expect(request.headers.get('authorization')).toBe('Bearer test-gitlab-token');
        return handler(new URL(request.url), request);
      }),
    ),
    Layer.provide(withConfig),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const mergeRequest = (overrides: Record<string, unknown>) => ({
  iid: 1,
  source_branch: 'feat/x',
  source_project_id: 42,
  ...overrides,
});

describe('GitLabSweeps.project', () => {
  it.effect('reads the default branch and web URL', () =>
    Effect.gen(function* () {
      const project = yield* (yield* GitLabSweeps).project({ projectId: '42' });
      expect(project).toEqual({ defaultBranch: 'trunk', webUrl: 'https://gitlab.com/acme/app' });
    }).pipe(
      Effect.provide(
        withSweeps(url => {
          expect(url.pathname).toBe('/api/v4/projects/42');
          return json({ default_branch: 'trunk', web_url: 'https://gitlab.com/acme/app' });
        }),
      ),
    ),
  );
});

describe('GitLabSweeps.openMergeRequestsFrom', () => {
  it.effect("lists the project's own open MRs from branches with the prefix", () =>
    Effect.gen(function* () {
      const open = yield* (yield* GitLabSweeps).openMergeRequestsFrom({
        projectId: '42',
        branchPrefix: 'codetinder/sweep-',
      });
      expect(open).toEqual([3]);
    }).pipe(
      Effect.provide(
        withSweeps(url => {
          expect(url.searchParams.get('state')).toBe('opened');
          return json([
            mergeRequest({ iid: 3, source_branch: 'codetinder/sweep-2026-10-16-093012' }),
            mergeRequest({ iid: 4, source_branch: 'feat/x' }),
            mergeRequest({ iid: 5, source_branch: 'codetinder/sweep-x', source_project_id: 99 }),
          ]);
        }),
      ),
    ),
  );

  it.effect("fails with GitLab's refusal", () =>
    Effect.gen(function* () {
      const error = yield* (yield* GitLabSweeps)
        .openMergeRequestsFrom({ projectId: '42', branchPrefix: 'codetinder/sweep-' })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(GitLabRequestFailed);
      expect(error.status).toBe(403);
    }).pipe(Effect.provide(withSweeps(() => json({ message: 'no' }, 403)))),
  );
});
