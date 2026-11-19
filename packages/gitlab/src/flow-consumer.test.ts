import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GitLabCatalog } from './catalog';
import { GitLabCatalogError } from './catalog-graphql';
import { CATALOG_ITEM_ID } from './catalog-item';

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

describe('GitLabCatalog.enable', () => {
  it.effect('creates the consumer starting rounds when an MR opens or a reviewer is asked', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const result = yield* catalog.enable({
        token: Redacted.make('oauth-token'),
        projectId: '87434709',
      });
      expect(result).toEqual({ consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274' });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.variables.input).toEqual({
              itemId: CATALOG_ITEM_ID,
              target: { projectId: 'gid://gitlab/Project/87434709' },
              triggerTypes: ['merge_request', 'merge_request_ready', 'assign_reviewer', 'mention'],
              triggerConditions: {
                mergeRequest: {
                  match: 'ALL',
                  rules: [{ field: 'action', operator: 'EQ', value: 'created' }],
                },
              },
            });
            return new Response(
              JSON.stringify({
                data: {
                  aiCatalogItemConsumerCreate: {
                    itemConsumer: { id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274' },
                    errors: [],
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabCatalogError when GitLab answers errors', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.enable({
          token: Redacted.make('oauth-token'),
          projectId: '87434709',
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toContain('Duo is not available for this project');
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(
            async () =>
              new Response(
                JSON.stringify({
                  data: {
                    aiCatalogItemConsumerCreate: {
                      itemConsumer: null,
                      errors: ['Duo is not available for this project'],
                    },
                  },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              ),
          ),
        ),
      ),
    ),
  );
});

describe('GitLabCatalog.update', () => {
  it.effect('updates pinned version of catalog consumer', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const result = yield* catalog.update({
        token: Redacted.make('oauth-token'),
        consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
        version: '1.2.0',
      });
      expect(result).toEqual({ consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274' });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.variables.input).toEqual({
              id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
              pinnedVersion: '1.2.0',
            });
            return new Response(
              JSON.stringify({
                data: {
                  aiCatalogItemConsumerUpdate: {
                    itemConsumer: {
                      id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
                    },
                    errors: [],
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabCatalogError when update has errors', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.update({
          token: Redacted.make('oauth-token'),
          consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
          version: '99.0.0',
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toContain('Version 99.0.0 not found');
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(
            async () =>
              new Response(
                JSON.stringify({
                  data: {
                    aiCatalogItemConsumerUpdate: {
                      itemConsumer: null,
                      errors: ['Version 99.0.0 not found'],
                    },
                  },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              ),
          ),
        ),
      ),
    ),
  );
});

describe('GitLabCatalog.disable', () => {
  it.effect('deletes the consumer by its id', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      yield* catalog.disable({
        token: Redacted.make('oauth-token'),
        consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.query).toContain('aiCatalogItemConsumerDelete(input: $input)');
            expect(body.variables.input).toEqual({
              id: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
            });
            return json({
              data: { aiCatalogItemConsumerDelete: { success: true, errors: [] } },
            });
          }),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabCatalogError when GitLab answers errors', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.disable({
          token: Redacted.make('oauth-token'),
          consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('You do not have permission to delete this consumer');
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async () =>
            json({
              data: {
                aiCatalogItemConsumerDelete: {
                  success: false,
                  errors: ['You do not have permission to delete this consumer'],
                },
              },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect('fails with GitLabCatalogError when GitLab neither succeeds nor says why', () =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const error = yield* Effect.flip(
        catalog.disable({
          token: Redacted.make('oauth-token'),
          consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/12494274',
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('GitLab failed to delete item consumer');
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async () =>
            json({ data: { aiCatalogItemConsumerDelete: { success: false, errors: [] } } }),
          ),
        ),
      ),
    ),
  );
});
