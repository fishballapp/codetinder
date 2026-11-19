import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GITLAB_BASE_URL } from './gitlab';
import { GitLabRemoval, REMOVAL_BRANCH, REMOVAL_TITLE } from './removal';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withRemoval = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabRemoval.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PROJECT = '87434709';
const PROJECT_PATH = `/api/v4/projects/${PROJECT}`;
const CONFIG_PATH = '.codetinder/config.json';
const DESCRIPTION = 'Removes CodeTinder.';
const SETUP_QUERY = 'source_branch=codetinder%2Fsetup&target_branch=main&state=opened';
const REMOVAL_QUERY = 'source_branch=codetinder%2Fremove&target_branch=main&state=opened';
const OWN_MR_URL = `${GITLAB_BASE_URL}/g/p/-/merge_requests/8`;

/** A merge request as GitLab lists it, opened from this project unless `fromProject` says otherwise. */
const mergeRequest = (iid: number, fromProject = Number(PROJECT)) => ({
  iid,
  web_url: `${GITLAB_BASE_URL}/g/p/-/merge_requests/${iid}`,
  source_project_id: fromProject,
});

/** Each request as its method, path and query, in the order GitLab received them. */
const recordRequests = (requests: string[]) => (request: Request) => {
  const url = new URL(request.url);
  requests.push(`${request.method} ${url.pathname}${url.search}`);
};

describe('GitLabRemoval.closeSetupMergeRequest', () => {
  it.effect('closes the open setup MR on the default branch', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.closeSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: PROJECT,
        defaultBranch: 'main',
      });
      expect(requests).toEqual([
        `GET ${PROJECT_PATH}/merge_requests?${SETUP_QUERY}`,
        `PUT ${PROJECT_PATH}/merge_requests/7`,
      ]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(async request => {
            recordRequests(requests)(request);
            if (request.method === 'GET') return json([mergeRequest(7)]);
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            expect(await request.json()).toEqual({ state_event: 'close' });
            return json({ ...mergeRequest(7), state: 'closed' });
          }),
        ),
      ),
    );
  });

  it.effect("closes only this project's own setup MR, not one from a fork", () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.closeSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: PROJECT,
        defaultBranch: 'main',
      });
      expect(requests).toEqual([
        `GET ${PROJECT_PATH}/merge_requests?${SETUP_QUERY}`,
        `PUT ${PROJECT_PATH}/merge_requests/7`,
      ]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            if (request.method === 'GET') {
              return json([mergeRequest(5, 999), mergeRequest(7)]);
            }
            return json({ ...mergeRequest(7), state: 'closed' });
          }),
        ),
      ),
    );
  });

  it.effect('does nothing when no setup MR is open', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.closeSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: PROJECT,
        defaultBranch: 'main',
      });
      expect(requests).toEqual([`GET ${PROJECT_PATH}/merge_requests?${SETUP_QUERY}`]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            return json([]);
          }),
        ),
      ),
    );
  });

  it.effect('does nothing when the only setup MR is from a fork', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.closeSetupMergeRequest({
        token: Redacted.make('oauth-token'),
        projectId: PROJECT,
        defaultBranch: 'main',
      });
      expect(requests).toEqual([`GET ${PROJECT_PATH}/merge_requests?${SETUP_QUERY}`]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            return json([mergeRequest(5, 999)]);
          }),
        ),
      ),
    );
  });
});

describe('GitLabRemoval.deleteSetupBranch', () => {
  it.effect('deletes the setup branch', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.deleteSetupBranch({ token: Redacted.make('oauth-token'), projectId: PROJECT });
      expect(requests).toEqual([`DELETE ${PROJECT_PATH}/repository/branches/codetinder%2Fsetup`]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            return new Response(null, { status: 204 });
          }),
        ),
      ),
    );
  });

  it.effect('is fine when the setup branch is already gone', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      yield* removal.deleteSetupBranch({ token: Redacted.make('oauth-token'), projectId: PROJECT });
      expect(requests).toHaveLength(1);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            return new Response(null, { status: 404 });
          }),
        ),
      ),
    );
  });
});

describe('GitLabRemoval.openRemovalMergeRequest', () => {
  const open = {
    token: Redacted.make('oauth-token'),
    projectId: PROJECT,
    defaultBranch: 'main',
    configPath: CONFIG_PATH,
    description: DESCRIPTION,
  };

  it.effect('commits the config deletion on the removal branch and opens the MR', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const url = yield* removal.openRemovalMergeRequest(open);
      expect(url).toBe(OWN_MR_URL);
      expect(requests).toEqual([
        `POST ${PROJECT_PATH}/repository/commits`,
        `POST ${PROJECT_PATH}/merge_requests`,
      ]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(async request => {
            recordRequests(requests)(request);
            if (request.url.endsWith('/repository/commits')) {
              expect(await request.json()).toEqual({
                branch: REMOVAL_BRANCH,
                start_branch: 'main',
                commit_message: REMOVAL_TITLE,
                actions: [{ action: 'delete', file_path: CONFIG_PATH }],
              });
              return json({ id: 'c0ffee' }, 201);
            }
            expect(await request.json()).toEqual({
              source_branch: REMOVAL_BRANCH,
              target_branch: 'main',
              title: REMOVAL_TITLE,
              description: DESCRIPTION,
              remove_source_branch: true,
            });
            return json(mergeRequest(8), 201);
          }),
        ),
      ),
    );
  });

  it.effect('answers the open removal MR when its branch already exists', () => {
    const requests: string[] = [];
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const url = yield* removal.openRemovalMergeRequest(open);
      expect(url).toBe(OWN_MR_URL);
      expect(requests).toEqual([
        `POST ${PROJECT_PATH}/repository/commits`,
        `GET ${PROJECT_PATH}/merge_requests?${REMOVAL_QUERY}`,
      ]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            if (request.method === 'POST') {
              return json({ message: "A branch called 'codetinder/remove' already exists" }, 400);
            }
            return json([mergeRequest(8)]);
          }),
        ),
      ),
    );
  });

  it.effect('replaces a leftover removal branch that has no open MR, then opens the MR', () => {
    const requests: string[] = [];
    let commits = 0;
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const url = yield* removal.openRemovalMergeRequest(open);
      expect(url).toBe(OWN_MR_URL);
      expect(requests).toEqual([
        `POST ${PROJECT_PATH}/repository/commits`,
        `GET ${PROJECT_PATH}/merge_requests?${REMOVAL_QUERY}`,
        `DELETE ${PROJECT_PATH}/repository/branches/codetinder%2Fremove`,
        `POST ${PROJECT_PATH}/repository/commits`,
        `POST ${PROJECT_PATH}/merge_requests`,
      ]);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            if (request.url.endsWith('/repository/commits')) {
              commits += 1;
              return commits === 1
                ? json({ message: "A branch called 'codetinder/remove' already exists" }, 400)
                : json({ id: 'c0ffee' }, 201);
            }
            if (request.method === 'POST') return json(mergeRequest(8), 201);
            return json([]);
          }),
        ),
      ),
    );
  });

  it.effect('ignores a removal MR opened from a fork and replaces the branch', () => {
    const requests: string[] = [];
    let commits = 0;
    return Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const url = yield* removal.openRemovalMergeRequest(open);
      expect(url).toBe(OWN_MR_URL);
      expect(requests).toContain(`DELETE ${PROJECT_PATH}/repository/branches/codetinder%2Fremove`);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            recordRequests(requests)(request);
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            if (request.url.endsWith('/repository/commits')) {
              commits += 1;
              return commits === 1
                ? json({ message: "A branch called 'codetinder/remove' already exists" }, 400)
                : json({ id: 'c0ffee' }, 201);
            }
            if (request.method === 'POST') return json(mergeRequest(8), 201);
            return json([mergeRequest(5, 999)]);
          }),
        ),
      ),
    );
  });

  it.effect('dies when the branch still refuses the commit after it was deleted', () =>
    Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const exit = yield* Effect.exit(removal.openRemovalMergeRequest(open));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            if (request.method === 'DELETE') return new Response(null, { status: 204 });
            if (request.method === 'POST' && request.url.endsWith('/repository/commits')) {
              return json({ message: "A branch called 'codetinder/remove' already exists" }, 400);
            }
            return json([]);
          }),
        ),
      ),
    ),
  );

  it.effect('answers the open MR when GitLab refuses to open a second one', () =>
    Effect.gen(function* () {
      const removal = yield* GitLabRemoval;
      const url = yield* removal.openRemovalMergeRequest(open);
      expect(url).toBe(OWN_MR_URL);
    }).pipe(
      Effect.provide(
        withRemoval(
          scriptedFetch(request => {
            if (request.method === 'POST' && request.url.endsWith('/repository/commits')) {
              return json({ id: 'c0ffee' }, 201);
            }
            if (request.method === 'POST') return json({ message: 'taken' }, 409);
            return json([mergeRequest(8)]);
          }),
        ),
      ),
    ),
  );
});
