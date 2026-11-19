import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { GitLabSweepPage, PipelineRefused } from './sweep-page';

const token = Redacted.make('oauth-token');

const withSweep = (handler: (request: Request) => Response | Promise<Response>) =>
  Layer.mergeAll(
    GitLabSweepPage.layer,
    Layer.succeed(FetchHttpClient.Fetch, async (input, init) =>
      handler(input instanceof Request ? input : new Request(input, init)),
    ),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('GitLabSweepPage.startPipeline', () => {
  it.effect('starts a pipeline on the ref', () =>
    Effect.gen(function* () {
      yield* (yield* GitLabSweepPage).startPipeline({ token, projectId: '42', ref: 'main' });
    }).pipe(
      Effect.provide(
        withSweep(async request => {
          expect(request.method).toBe('POST');
          expect(new URL(request.url).pathname).toBe('/api/v4/projects/42/pipeline');
          expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
          expect(await request.json()).toEqual({ ref: 'main' });
          return json({ id: 1, source: 'api' }, 201);
        }),
      ),
    ),
  );

  it.effect("fails with GitLab's reason, as it says it", () =>
    Effect.gen(function* () {
      const refusal = (body: unknown, status: number) =>
        Effect.flip(
          Effect.gen(function* () {
            yield* (yield* GitLabSweepPage).startPipeline({ token, projectId: '42', ref: 'main' });
          }).pipe(Effect.provide(withSweep(() => json(body, status)))),
        );
      const fromRules = yield* refusal(
        { message: { base: ['Pipeline will not run for the selected trigger.'] } },
        400,
      );
      expect(fromRules).toBeInstanceOf(PipelineRefused);
      expect(fromRules.message).toBe('Pipeline will not run for the selected trigger.');
      expect((yield* refusal({ message: '403 Forbidden' }, 403)).message).toBe('403 Forbidden');
    }),
  );
});

describe('GitLabSweepPage.compare', () => {
  const compare = (body: unknown) =>
    Effect.gen(function* () {
      return yield* (yield* GitLabSweepPage).compare({
        token,
        projectId: '42',
        from: 'abc123',
        to: 'main',
      });
    }).pipe(
      Effect.provide(
        withSweep(request => {
          const url = new URL(request.url);
          expect(url.pathname).toBe('/api/v4/projects/42/repository/compare');
          expect(Object.fromEntries(url.searchParams)).toEqual({ from: 'abc123', to: 'main' });
          return json(body);
        }),
      ),
    );

  it.effect('counts each file’s added lines from its diff', () =>
    Effect.gen(function* () {
      expect(
        yield* compare({
          compare_timeout: false,
          diffs: [
            {
              new_path: 'src/cart.ts',
              diff: '@@ -1,3 +1,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n \\ No newline at end of file\n',
              collapsed: false,
              too_large: false,
            },
            { new_path: 'src/gone.ts', diff: '@@ -1 +0,0 @@\n-gone\n' },
          ],
        }),
      ).toEqual({
        files: [
          { path: 'src/cart.ts', addedLines: 2, isTruncated: false },
          { path: 'src/gone.ts', addedLines: 0, isTruncated: false },
        ],
        isTruncated: false,
      });
    }),
  );

  it.effect('says when GitLab withheld a diff, or stopped comparing', () =>
    Effect.gen(function* () {
      expect(
        yield* compare({
          compare_timeout: true,
          diffs: [
            { new_path: 'pnpm-lock.yaml', diff: '', too_large: true },
            { new_path: 'src/big.ts', diff: '', collapsed: true },
          ],
        }),
      ).toEqual({
        files: [
          { path: 'pnpm-lock.yaml', addedLines: 0, isTruncated: true },
          { path: 'src/big.ts', addedLines: 0, isTruncated: true },
        ],
        isTruncated: true,
      });
    }),
  );
});

describe('GitLabSweepPage.mergeRequest', () => {
  const read = (response: Response) =>
    Effect.gen(function* () {
      return yield* (yield* GitLabSweepPage).mergeRequest({
        token,
        projectId: '42',
        mergeRequestIid: 7,
      });
    }).pipe(
      Effect.provide(
        withSweep(request => {
          expect(new URL(request.url).pathname).toBe('/api/v4/projects/42/merge_requests/7');
          return response;
        }),
      ),
    );

  it.effect('reads its page and whether it is open', () =>
    Effect.gen(function* () {
      const url = 'https://gitlab.com/g/p/-/merge_requests/7';
      expect(yield* read(json({ web_url: url, state: 'opened' }))).toEqual(
        Option.some({ url, isOpen: true }),
      );
      expect(yield* read(json({ web_url: url, state: 'merged' }))).toEqual(
        Option.some({ url, isOpen: false }),
      );
    }),
  );

  it.effect('is none when the MR is gone', () =>
    Effect.gen(function* () {
      expect(yield* read(json({ message: '404 Not found' }, 404))).toEqual(Option.none());
    }),
  );
});

describe('GitLabSweepPage.sweepSession', () => {
  const sessionUrl = (id: number) => `https://gitlab.com/g/p/-/automate/agent-sessions/${id}`;
  const pipelineGoal = (ref: string, status: string) =>
    JSON.stringify({ object_kind: 'pipeline', object_attributes: { ref, status } });
  const find = (nodes: readonly { readonly goal: string | null; readonly webUrl: string }[]) =>
    Effect.gen(function* () {
      return yield* (yield* GitLabSweepPage).sweepSession({
        token,
        projectFullPath: 'g/p',
        defaultBranch: 'main',
      });
    }).pipe(
      Effect.provide(
        withSweep(async request => {
          expect(new URL(request.url).pathname).toBe('/api/graphql');
          expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
          const { query, variables } = await request.json();
          expect(query).toContain('statuses: [CREATED, RUNNING]');
          expect(variables).toEqual({ fullPath: 'g/p' });
          return json({ data: { project: { duoWorkflowWorkflows: { nodes } } } });
        }),
      ),
    );

  it.effect('is the oldest active session a passing default-branch pipeline started', () =>
    Effect.gen(function* () {
      expect(
        yield* find([
          { goal: '136', webUrl: sessionUrl(4) },
          { goal: pipelineGoal('main', 'success'), webUrl: sessionUrl(3) },
          { goal: pipelineGoal('feat/x', 'running'), webUrl: sessionUrl(2) },
          { goal: pipelineGoal('main', 'success'), webUrl: sessionUrl(1) },
        ]),
      ).toEqual(Option.some(sessionUrl(1)));
    }),
  );

  it.effect('is none while only rounds run', () =>
    Effect.gen(function* () {
      expect(
        yield* find([
          { goal: '136', webUrl: sessionUrl(2) },
          { goal: null, webUrl: sessionUrl(1) },
        ]),
      ).toEqual(Option.none());
    }),
  );
});
