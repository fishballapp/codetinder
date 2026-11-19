import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as TestClock from 'effect/testing/TestClock';
import { GitLabCatalog } from './catalog';

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

describe('GitLabCatalog under a transient failure', () => {
  const afterBackoffs = TestClock.adjust('2 seconds');

  /** GitLab fails the first attempt with a 503, then answers `body`. */
  const failingOnce = (body: unknown) => {
    const counter = { attempts: 0 };
    const fetch = scriptedFetch(() => {
      counter.attempts += 1;
      return counter.attempts === 1 ? new Response('', { status: 503 }) : json(body);
    });
    return { counter, layer: withCatalog(fetch) };
  };

  it.effect('reads again, though a query is a POST', () => {
    const { counter, layer } = failingOnce({
      data: { projects: { nodes: [] }, aiCatalogItem: { latestVersion: { versionName: '1.1.0' } } },
    });
    return Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const fiber = yield* Effect.forkChild(
        catalog.setupStatuses({
          token: Redacted.make('oauth-token'),
          projectFullPaths: [],
          configPath: CONFIG_PATH,
        }),
      );
      yield* afterBackoffs;
      expect(yield* Fiber.join(fiber)).toEqual({ latestVersion: '1.1.0', projects: [] });
      expect(counter.attempts).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('writes again a mutation that sets the pinned version', () => {
    const { counter, layer } = failingOnce({
      data: { aiCatalogItemConsumerUpdate: { itemConsumer: { id: 'consumer' }, errors: [] } },
    });
    return Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const fiber = yield* Effect.forkChild(
        catalog.update({
          token: Redacted.make('oauth-token'),
          consumerId: 'consumer',
          version: '1.2.0',
        }),
      );
      yield* afterBackoffs;
      expect(yield* Fiber.join(fiber)).toEqual({ consumerId: 'consumer' });
      expect(counter.attempts).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect('does not write again a mutation that creates the consumer', () => {
    const { counter, layer } = failingOnce({});
    return Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      const fiber = yield* Effect.forkChild(
        Effect.exit(catalog.enable({ token: Redacted.make('oauth-token'), projectId: '1' })),
      );
      yield* afterBackoffs;
      expect(Exit.hasDies(yield* Fiber.join(fiber))).toBe(true);
      expect(counter.attempts).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
