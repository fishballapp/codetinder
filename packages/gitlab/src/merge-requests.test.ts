import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as TestClock from 'effect/testing/TestClock';
import { GITLAB_BASE_URL, GitLabRequestFailed } from './gitlab';
import { GitLabMergeRequests } from './merge-requests';

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

const withMergeRequests = (fetch: typeof globalThis.fetch) =>
  GitLabMergeRequests.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    Layer.provide(withConfig),
  );

const passBackoffs = Effect.forEach(
  Array.from({ length: 5 }),
  () => TestClock.adjust('1 second').pipe(Effect.andThen(Effect.yieldNow)),
  { discard: true },
);

describe('GitLabMergeRequests.list', () => {
  it.effect("searches the project's own MRs in the state, leaving out a fork's", () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const listed = yield* mr.list({
        projectId: '42',
        state: 'closed',
        search: 'codetinder:sandbox-fix',
      });
      expect(listed).toEqual([
        {
          iid: 3,
          webUrl: 'https://gitlab.com/x/-/merge_requests/3',
          description: '',
          sourceBranch: 'codetinder/sandbox-fix-a',
          targetBranch: 'main',
        },
      ]);
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(request => {
            const url = new URL(request.url);
            expect(url.pathname).toBe('/api/v4/projects/42/merge_requests');
            expect(url.searchParams.get('search')).toBe('codetinder:sandbox-fix');
            expect(url.searchParams.get('state')).toBe('closed');
            const listed = (iid: number, projectId: number) => ({
              iid,
              web_url: `https://gitlab.com/x/-/merge_requests/${iid}`,
              description: null,
              source_branch: 'codetinder/sandbox-fix-a',
              target_branch: 'main',
              source_project_id: projectId,
            });
            return new Response(JSON.stringify([listed(3, 42), listed(4, 99)]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    ),
  );
});

describe('GitLabMergeRequests.updateDescription', () => {
  it.effect('puts the new description on the MR', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      yield* mr.updateDescription({ projectId: '42', mergeRequestIid: 3, description: 'new' });
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(async request => {
            expect(request.method).toBe('PUT');
            expect(new URL(request.url).pathname).toBe('/api/v4/projects/42/merge_requests/3');
            expect(await request.json()).toEqual({ description: 'new' });
            return new Response('{}', { status: 200 });
          }),
        ),
      ),
    ),
  );
});

describe('GitLabMergeRequests.get', () => {
  it.effect('returns targetBranch on 200', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const res = yield* mr.get({ projectId: '87434709', mergeRequestIid: 12 });
      expect(res).toEqual({
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        webUrl: 'https://gitlab.com/group/demo/-/merge_requests/12',
        isDraft: true,
        isOpen: true,
        sourceProjectId: 87434709,
        targetProjectId: 87434709,
      });
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(request => {
            expect(request.url).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/87434709/merge_requests/12`,
            );
            expect(request.headers.get('authorization')).toBe('Bearer test-gitlab-token');
            return new Response(
              JSON.stringify({
                source_branch: 'feat/x',
                target_branch: 'main',
                web_url: 'https://gitlab.com/group/demo/-/merge_requests/12',
                draft: true,
                state: 'opened',
                source_project_id: 87434709,
                target_project_id: 87434709,
              }),
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

  it.effect('fails with GitLabRequestFailed on 404', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const error = yield* Effect.flip(mr.get({ projectId: '87434709', mergeRequestIid: 999 }));
      expect(error).toBeInstanceOf(GitLabRequestFailed);
      expect(error.status).toBe(404);
      expect(error.message).toContain('404');
    }).pipe(
      Effect.provide(withMergeRequests(scriptedFetch(() => new Response('', { status: 404 })))),
    ),
  );
});

const CREATED_NOTE = { id: 101, author: { username: 'ai-codetinder-acme' } };

describe('GitLabMergeRequests.createNote', () => {
  it.effect('creates note on 201', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const created = yield* mr.createNote({
        projectId: 'group/subgroup%2Fproject',
        mergeRequestIid: 5,
        body: 'Hello note',
      });
      expect(created).toEqual({ authorUsername: 'ai-codetinder-acme' });
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(async request => {
            expect(request.url).toBe(
              `${GITLAB_BASE_URL}/api/v4/projects/group%2Fsubgroup%252Fproject/merge_requests/5/notes`,
            );
            expect(request.headers.get('authorization')).toBe('Bearer test-gitlab-token');
            const json = await request.json();
            expect(json).toEqual({ body: 'Hello note' });
            return new Response(JSON.stringify(CREATED_NOTE), {
              status: 201,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabRequestFailed on 403', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const error = yield* Effect.flip(
        mr.createNote({ projectId: '123', mergeRequestIid: 5, body: 'Note' }),
      );
      expect(error).toBeInstanceOf(GitLabRequestFailed);
      expect(error.status).toBe(403);
    }).pipe(
      Effect.provide(withMergeRequests(scriptedFetch(() => new Response('', { status: 403 })))),
    ),
  );

  it.effect('retries transient 500 status until success', () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const fiber = yield* Effect.forkChild(
        mr.createNote({ projectId: '123', mergeRequestIid: 5, body: 'Note' }),
      );
      yield* passBackoffs;
      yield* Fiber.join(fiber);
      expect(attempts).toBe(3);
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(() => {
            attempts += 1;
            return attempts < 3 ? new Response('', { status: 500 }) : json(CREATED_NOTE, 201);
          }),
        ),
      ),
    );
  });

  it.effect('retries an attempt GitLab is slow to answer', () => {
    let attempts = 0;
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const fiber = yield* Effect.forkChild(mr.get({ projectId: '123', mergeRequestIid: 1 }));
      yield* TestClock.adjust('25 seconds');
      yield* TestClock.adjust('1 second');
      const got = yield* Fiber.join(fiber);
      expect(got.targetBranch).toBe('main');
      expect(attempts).toBe(2);
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(() => {
            attempts += 1;
            return attempts === 1
              ? new Promise<Response>(() => {})
              : json({
                  source_branch: 'feat/x',
                  target_branch: 'main',
                  web_url: 'https://gitlab.com/group/demo/-/merge_requests/1',
                  draft: false,
                  state: 'merged',
                  source_project_id: 123,
                  target_project_id: 123,
                });
          }),
        ),
      ),
    );
  });

  it.effect('dies when GitLab answers no attempt within 25 seconds', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const fiber = yield* Effect.forkChild(
        Effect.exit(mr.get({ projectId: '123', mergeRequestIid: 1 })),
      );
      yield* Effect.forEach(
        Array.from({ length: 4 }),
        () => TestClock.adjust('30 seconds').pipe(Effect.andThen(Effect.yieldNow)),
        { discard: true },
      );
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
    }).pipe(
      Effect.provide(withMergeRequests(scriptedFetch(() => new Promise<Response>(() => {})))),
    ),
  );
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('GitLabMergeRequests.createMergeRequest', () => {
  it.effect('opens the MR from source into target, removing the source branch on merge', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const created = yield* mr.createMergeRequest({
        projectId: '42',
        sourceBranch: 'codetinder/learn-1',
        targetBranch: 'feat/x',
        title: 'Learn',
        description: 'Body',
      });
      expect(created).toEqual({
        iid: 9,
        webUrl: 'https://gitlab.com/group/demo/-/merge_requests/9',
      });
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(async request => {
            expect(request.method).toBe('POST');
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/v4/projects/42/merge_requests`);
            expect(await request.json()).toEqual({
              source_branch: 'codetinder/learn-1',
              target_branch: 'feat/x',
              title: 'Learn',
              description: 'Body',
              remove_source_branch: true,
              squash: false,
            });
            return json(
              { iid: 9, web_url: 'https://gitlab.com/group/demo/-/merge_requests/9' },
              201,
            );
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabRequestFailed on 409', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const error = yield* Effect.flip(
        mr.createMergeRequest({
          projectId: '42',
          sourceBranch: 'a',
          targetBranch: 'b',
          title: 'T',
          description: 'D',
        }),
      );
      expect(error).toBeInstanceOf(GitLabRequestFailed);
      expect(error.status).toBe(409);
    }).pipe(
      Effect.provide(withMergeRequests(scriptedFetch(() => new Response('', { status: 409 })))),
    ),
  );
});

describe('GitLabMergeRequests.replyToNote', () => {
  const discussionsPage1 = [{ id: 'first', notes: [{ id: 11 }, { id: 12 }] }];
  const discussionsPage2 = [{ id: 'second', notes: [{ id: 22 }] }];

  const paginatedDiscussions = (request: Request) => {
    const page = new URL(request.url).searchParams.get('page');
    if (page === '2') return json(discussionsPage2);
    return json(discussionsPage1, 200, { 'x-next-page': '2' });
  };

  it.effect('replies in the discussion holding the note, found on a later page', () => {
    const posted: string[] = [];
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      yield* mr.replyToNote({ projectId: '42', mergeRequestIid: 7, noteId: 22, body: 'Done' });
      expect(posted).toEqual([
        `${GITLAB_BASE_URL}/api/v4/projects/42/merge_requests/7/discussions/second/notes`,
      ]);
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(async request => {
            if (request.method === 'GET') return paginatedDiscussions(request);
            posted.push(request.url);
            expect(await request.json()).toEqual({ body: 'Done' });
            return json({ id: 77 }, 201);
          }),
        ),
      ),
    );
  });

  it.effect('fails with NoteNotFound, and posts nothing, when no discussion holds the note', () => {
    let posts = 0;
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const error = yield* Effect.flip(
        mr.replyToNote({ projectId: '42', mergeRequestIid: 7, noteId: 999, body: 'Done' }),
      );
      expect(error._tag).toBe('NoteNotFound');
      expect(posts).toBe(0);
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(request => {
            if (request.method !== 'GET') posts += 1;
            return paginatedDiscussions(request);
          }),
        ),
      ),
    );
  });

  it.effect('fails with GitLabRequestFailed when the reply is refused', () =>
    Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const error = yield* Effect.flip(
        mr.replyToNote({ projectId: '42', mergeRequestIid: 7, noteId: 11, body: 'Done' }),
      );
      expect(error).toMatchObject({ _tag: 'GitLabRequestFailed', status: 403 });
    }).pipe(
      Effect.provide(
        withMergeRequests(
          scriptedFetch(request =>
            request.method === 'GET'
              ? paginatedDiscussions(request)
              : new Response('', { status: 403 }),
          ),
        ),
      ),
    ),
  );
});

describe('GitLabMergeRequests.finishReview', () => {
  const REVIEWERS_PATH = '/api/v4/projects/42/merge_requests/3/reviewers';
  const PUBLISH_PATH = '/api/v4/projects/42/merge_requests/3/draft_notes/bulk_publish';

  /** Answers the MR's reviewers, and records each review it is asked to publish. */
  const reviewersFetch = (reviewers: readonly { username: string; state: string }[]) => {
    const published: unknown[] = [];
    const fetch = scriptedFetch(async request => {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === REVIEWERS_PATH) {
        return json(reviewers.map(({ username, state }) => ({ user: { id: 1, username }, state })));
      }
      if (request.method === 'POST' && pathname === PUBLISH_PATH) {
        published.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return new Response('', { status: 404 });
    });
    return { fetch, published };
  };

  it.effect('marks the review done while the reviewer has not reviewed', () => {
    const { fetch, published } = reviewersFetch([
      { username: 'dev', state: 'unreviewed' },
      { username: 'ai-codetinder-acme', state: 'unreviewed' },
    ]);
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const isFinished = yield* mr.finishReview({
        projectId: '42',
        mergeRequestIid: 3,
        reviewer: 'ai-codetinder-acme',
      });
      expect(isFinished).toBe(true);
      expect(published).toEqual([{ reviewer_state: 'reviewed' }]);
    }).pipe(Effect.provide(withMergeRequests(fetch)));
  });

  const untouched: [string, { username: string; state: string }[]][] = [
    ['not a reviewer', [{ username: 'dev', state: 'unreviewed' }]],
    ['already reviewed', [{ username: 'ai-codetinder-acme', state: 'reviewed' }]],
    ['asking for changes', [{ username: 'ai-codetinder-acme', state: 'requested_changes' }]],
  ];
  it.effect.each(untouched)('leaves the review alone when the reviewer is %s', ([, reviewers]) => {
    const { fetch, published } = reviewersFetch(reviewers);
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      const isFinished = yield* mr.finishReview({
        projectId: '42',
        mergeRequestIid: 3,
        reviewer: 'ai-codetinder-acme',
      });
      expect(isFinished).toBe(false);
      expect(published).toEqual([]);
    }).pipe(Effect.provide(withMergeRequests(fetch)));
  });
});

describe('GitLabMergeRequests.latestReviewRequest', () => {
  const NOTES_PATH = '/api/v4/projects/42/merge_requests/3/notes';

  const latestRequest = (notes: readonly { id: number; system: boolean; body: string }[]) => {
    const fetch = scriptedFetch(request => {
      const url = new URL(request.url);
      expect(url.pathname).toBe(NOTES_PATH);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        sort: 'desc',
        order_by: 'created_at',
        per_page: '100',
      });
      return json(notes);
    });
    return Effect.gen(function* () {
      const mr = yield* GitLabMergeRequests;
      return yield* mr.latestReviewRequest({
        projectId: '42',
        mergeRequestIid: 3,
        reviewer: 'ai-codetinder-acme',
      });
    }).pipe(Effect.provide(withMergeRequests(fetch)));
  };

  it.effect("answers the newest system note requesting the reviewer's review", () =>
    Effect.gen(function* () {
      const request = yield* latestRequest([
        { id: 9, system: false, body: 'requested review from @ai-codetinder-acme' },
        { id: 8, system: true, body: 'requested review from @dev' },
        { id: 7, system: true, body: 'requested review from @dev and @ai-codetinder-acme' },
        { id: 6, system: true, body: 'requested review from @ai-codetinder-acme' },
      ]);
      expect(request).toEqual(Option.some(7));
    }),
  );

  it.effect('answers none when no note requests it, or one only removes it', () =>
    Effect.gen(function* () {
      const request = yield* latestRequest([
        {
          id: 5,
          system: true,
          body: 'requested review from @dev and removed review request for @ai-codetinder-acme',
        },
        { id: 4, system: true, body: 'requested review from @ai-codetinder-acme-2' },
      ]);
      expect(request).toEqual(Option.none());
    }),
  );
});
