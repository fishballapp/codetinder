import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GitLabCatalog } from './catalog';
import { GitLabCatalogError } from './catalog-graphql';
import { CATALOG_ITEM_ID } from './catalog-item';
import { GITLAB_BASE_URL } from './gitlab';
import { REMOVAL_BRANCH } from './removal';
import { SETUP_BRANCH } from './setup';
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

const withCatalog = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabCatalog.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CONFIG_PATH = '.codetinder/config.json';

const bareNode = (fullPath: string) => ({
  fullPath,
  markedForDeletion: false,
  userPermissions: { adminAiCatalogItemConsumer: true },
  aiCatalogItemConsumerForItem: null,
  setupMergeRequests: { nodes: [] },
  removalMergeRequests: { nodes: [] },
  repository: { blobs: { nodes: [] } },
});

describe('GitLabCatalog.setupStatuses', () => {
  it.effect('reports each setup state and leaves out a path GitLab does not return', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const result = yield* catalog.setupStatuses({
        token: Redacted.make('oauth-token'),
        projectFullPaths: ['g/todo-demo', 'g/removing', 'g/codetinder', 'g/empty', 'g/private'],
        configPath: CONFIG_PATH,
      });
      expect(result).toEqual({
        latestVersion: '1.1.0',
        projects: [
          {
            fullPath: 'g/todo-demo',
            consumer: {
              id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
              pinnedVersion: '1.1.0',
            },
            setupMergeRequestUrl: 'https://gitlab.com/g/todo-demo/-/merge_requests/3',
            removalMergeRequest: null,
            hasConfig: true,
            isMarkedForDeletion: false,
            canEnableFlow: true,
          },
          {
            fullPath: 'g/removing',
            consumer: null,
            setupMergeRequestUrl: null,
            removalMergeRequest: {
              iid: '4',
              url: 'https://gitlab.com/g/removing/-/merge_requests/4',
            },
            hasConfig: true,
            isMarkedForDeletion: false,
            canEnableFlow: true,
          },
          {
            fullPath: 'g/codetinder',
            consumer: null,
            setupMergeRequestUrl: null,
            removalMergeRequest: null,
            hasConfig: false,
            isMarkedForDeletion: false,
            canEnableFlow: true,
          },
          {
            fullPath: 'g/empty',
            consumer: null,
            setupMergeRequestUrl: null,
            removalMergeRequest: null,
            hasConfig: false,
            isMarkedForDeletion: false,
            canEnableFlow: true,
          },
        ],
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            expect(request.url).toBe(`${GITLAB_BASE_URL}/api/graphql`);
            expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
            const body = await request.json();
            expect(body.variables).toEqual({
              fullPaths: ['g/todo-demo', 'g/removing', 'g/codetinder', 'g/empty', 'g/private'],
              itemId: CATALOG_ITEM_ID,
              setupBranch: SETUP_BRANCH,
              removalBranch: REMOVAL_BRANCH,
              configPath: CONFIG_PATH,
            });
            return json({
              data: {
                projects: {
                  nodes: [
                    {
                      fullPath: 'g/todo-demo',
                      markedForDeletion: false,
                      userPermissions: { adminAiCatalogItemConsumer: true },
                      aiCatalogItemConsumerForItem: {
                        id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
                        pinnedItemVersion: { versionName: '1.1.0' },
                      },
                      setupMergeRequests: {
                        nodes: [{ webUrl: 'https://gitlab.com/g/todo-demo/-/merge_requests/3' }],
                      },
                      removalMergeRequests: { nodes: [] },
                      repository: { blobs: { nodes: [{ path: CONFIG_PATH }] } },
                    },
                    {
                      ...bareNode('g/removing'),
                      removalMergeRequests: {
                        nodes: [
                          {
                            iid: '4',
                            webUrl: 'https://gitlab.com/g/removing/-/merge_requests/4',
                          },
                        ],
                      },
                      repository: { blobs: { nodes: [{ path: CONFIG_PATH }] } },
                    },
                    bareNode('g/codetinder'),
                    {
                      ...bareNode('g/empty'),
                      repository: null,
                    },
                  ],
                },
                aiCatalogItem: { latestVersion: { versionName: '1.1.0' } },
              },
            });
          }),
        ),
      ),
    ),
  );

  it.effect(
    'reports a project scheduled for deletion, and one the user cannot enable the flow in',
    () =>
      Effect.gen(function* () {
        const catalog = yield* GitLabCatalog;
        const result = yield* catalog.setupStatuses({
          token: Redacted.make('oauth-token'),
          projectFullPaths: ['g/deleting', 'g/personal'],
          configPath: CONFIG_PATH,
        });
        expect(
          result.projects.map(({ fullPath, isMarkedForDeletion, canEnableFlow }) => ({
            fullPath,
            isMarkedForDeletion,
            canEnableFlow,
          })),
        ).toEqual([
          { fullPath: 'g/deleting', isMarkedForDeletion: true, canEnableFlow: true },
          { fullPath: 'g/personal', isMarkedForDeletion: false, canEnableFlow: false },
        ]);
      }).pipe(
        Effect.provide(
          withCatalog(
            scriptedFetch(async () =>
              json({
                data: {
                  projects: {
                    nodes: [
                      { ...bareNode('g/deleting'), markedForDeletion: true },
                      {
                        ...bareNode('g/personal'),
                        userPermissions: { adminAiCatalogItemConsumer: false },
                      },
                    ],
                  },
                  aiCatalogItem: { latestVersion: { versionName: '1.1.0' } },
                },
              }),
            ),
          ),
        ),
      ),
  );

  it.effect(
    'splits more than 20 projects into requests of at most 20 and keeps input order',
    () => {
      const projectFullPaths = Array.from({ length: 50 }, (_, i) => `g/project-${i}`);
      const requestedSizes: number[] = [];
      return Effect.gen(function* () {
        const catalog = yield* GitLabCatalog;
        const result = yield* catalog.setupStatuses({
          token: Redacted.make('oauth-token'),
          projectFullPaths,
          configPath: CONFIG_PATH,
        });
        expect(requestedSizes.toSorted((a, b) => a - b)).toEqual([10, 20, 20]);
        expect(result.projects.map(project => project.fullPath)).toEqual(projectFullPaths);
      }).pipe(
        Effect.provide(
          withCatalog(
            scriptedFetch(async request => {
              const body = await request.json();
              const fullPaths: string[] = body.variables.fullPaths;
              requestedSizes.push(fullPaths.length);
              // Answer in reverse so the result order can only come from the input order.
              return json({
                data: {
                  projects: { nodes: fullPaths.toReversed().map(bareNode) },
                  aiCatalogItem: { latestVersion: { versionName: '1.1.0' } },
                },
              });
            }),
          ),
        ),
      );
    },
  );

  it.effect('makes one request for no projects, to read the latest version', () => {
    const variables: unknown[] = [];
    return Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const result = yield* catalog.setupStatuses({
        token: Redacted.make('oauth-token'),
        projectFullPaths: [],
        configPath: CONFIG_PATH,
      });
      expect(variables).toHaveLength(1);
      expect(result).toEqual({ latestVersion: '1.1.0', projects: [] });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            variables.push(body.variables);
            return json({
              data: {
                projects: { nodes: [] },
                aiCatalogItem: { latestVersion: { versionName: '1.1.0' } },
              },
            });
          }),
        ),
      ),
    );
  });

  it.effect('fails with InvalidToken when GitLab rejects the token', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.setupStatuses({
          token: Redacted.make('revoked-token'),
          projectFullPaths: ['g/todo-demo'],
          configPath: CONFIG_PATH,
        }),
      );
      expect(error).toBeInstanceOf(InvalidToken);
      expect(error.message).toBe('GitLab rejected the token');
    }).pipe(
      Effect.provide(
        withCatalog(scriptedFetch(async () => json({ message: '401 Unauthorized' }, 401))),
      ),
    ),
  );

  it.effect('fails with GitLabCatalogError when GitLab answers errors', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.setupStatuses({
          token: Redacted.make('oauth-token'),
          projectFullPaths: ['g/todo-demo'],
          configPath: CONFIG_PATH,
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('Complexity limit exceeded');
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async () => json({ errors: [{ message: 'Complexity limit exceeded' }] })),
        ),
      ),
    ),
  );
});
