import { CATALOG_ITEM_ID } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import { ReleaseError, releaseFlow } from './release';

type Sent = { readonly url: string; readonly authorization: string | null; readonly body: unknown };

/** Answers every request with `body`, recording what was sent. */
const gitlab = (body: unknown, sent: Sent[] = []) => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    sent.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: await request.json(),
    });
    return Response.json(body);
  };
  return Layer.mergeAll(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        CI_API_GRAPHQL_URL: 'https://gitlab.example.com/api/graphql',
        AI_CATALOG_TOKEN: 'catalog-token',
      }),
    ),
  );
};

describe('releaseFlow', () => {
  it.effect('updates the catalog item with the definition, as the token', () => {
    const sent: Sent[] = [];
    return Effect.gen(function* () {
      yield* releaseFlow('version: "v1"\n');
      expect(sent).toEqual([
        {
          url: 'https://gitlab.example.com/api/graphql',
          authorization: 'Bearer catalog-token',
          body: {
            query: expect.stringContaining('aiCatalogFlowUpdate'),
            variables: {
              input: { id: CATALOG_ITEM_ID, definition: 'version: "v1"\n', release: true },
            },
          },
        },
      ]);
    }).pipe(Effect.provide(gitlab({ data: { aiCatalogFlowUpdate: { errors: [] } } }, sent)));
  });

  it.effect('fails when GitLab refuses the definition', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(releaseFlow('version: "v1"\n'));
      expect(error).toEqual(
        new ReleaseError({ message: 'GitLab refused the release: flow: Field required' }),
      );
    }).pipe(
      Effect.provide(
        gitlab({ data: { aiCatalogFlowUpdate: { errors: ['flow: Field required'] } } }),
      ),
    ),
  );

  it.effect('fails on a GraphQL error', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(releaseFlow('version: "v1"\n'));
      expect(error).toEqual(
        new ReleaseError({ message: 'GitLab refused the release: Not authorized' }),
      );
    }).pipe(
      Effect.provide(
        gitlab({ data: { aiCatalogFlowUpdate: null }, errors: [{ message: 'Not authorized' }] }),
      ),
    ),
  );
});
