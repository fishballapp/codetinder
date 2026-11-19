import { RoundNotFound } from '@codetinder/api';
import {
  GitLabCatalog,
  GitLabOAuth,
  GitLabProjects,
  roundStartsOf,
  roundTrigger,
} from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import * as Reactivity from 'effect/reactivity/Reactivity';
import { Session } from '../auth/auth';
import { roundDetailsAtom, setRoundStartAtom } from './atoms';
import { webRuntime } from './runtime';

describe('roundDetailsAtom', () => {
  it('exercises exported roundDetailsAtom through AtomRegistry with test layer, failing with RoundNotFound without making API requests', async () => {
    let apiCallMade = false;

    const mockFetch = Layer.succeed(FetchHttpClient.Fetch, async () => {
      apiCallMade = true;
      throw new Error('API request should not be made');
    });

    const mockOAuth = Layer.succeed(
      GitLabOAuth,
      GitLabOAuth.of({
        buildAuthorizeUrl: () => '...',
        exchangeCode: () => Effect.die(new Error('not called')),
        refreshToken: () => Effect.die(new Error('not called')),
      }),
    );

    const testLayer = Session.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(mockOAuth, GitLabProjects.layer, mockFetch)),
    );

    const registry = AtomRegistry.make({
      initialValues: [[webRuntime.layer, testLayer]],
    });

    const atom = roundDetailsAtom('invalid-round-id');

    const result = await new Promise<AsyncResult.AsyncResult<unknown, unknown>>(resolve => {
      let unsub: (() => void) | undefined;
      let resolved = false;
      const sub = registry.subscribe(
        atom,
        res => {
          if (!AsyncResult.isInitial(res) && !resolved) {
            resolved = true;
            unsub?.();
            resolve(res);
          }
        },
        { immediate: true },
      );
      unsub = sub;
      if (resolved) {
        unsub();
      }
    });

    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) {
      const error = Cause.squash(result.cause);
      expect(error).toBeInstanceOf(RoundNotFound);
    }

    expect(apiCallMade).toBe(false);
  });
});

describe('setRoundStartAtom', () => {
  it.live('lands two quick ticks in turn, each on what the one before wrote', () =>
    Effect.gen(function* () {
      // The trigger as GitLab holds it; a write lands a moment after it reads.
      let eventTypes = roundTrigger({
        starts: new Set(['opened']),
        defaultBranch: 'main',
      }).eventTypes;
      const notCalled = () => Effect.die(new Error('not called'));
      const catalog = Layer.succeed(
        GitLabCatalog,
        GitLabCatalog.of({
          setupStatuses: notCalled,
          enable: notCalled,
          update: notCalled,
          createTrigger: notCalled,
          deleteTrigger: notCalled,
          disable: notCalled,
          flowTriggers: () =>
            Effect.sync(() => ({
              round: Option.some({ id: 'round-trigger', eventTypes }),
              sweeps: [],
              serviceAccountId: Option.none(),
              serviceAccountUsername: Option.none(),
              hasCiConfig: true,
            })),
          updateTrigger: ({ eventTypes: written }) =>
            Effect.sleep('20 millis').pipe(
              Effect.andThen(
                Effect.sync(() => {
                  eventTypes = written;
                }),
              ),
            ),
        }),
      );
      const session = Layer.succeed(
        Session,
        Session.of({
          getValidAccessToken: () => Effect.succeed('token'),
          setToken: () => Effect.void,
          clearToken: () => Effect.void,
        }),
      );
      const registry = AtomRegistry.make({
        initialValues: [[webRuntime.layer, Layer.mergeAll(catalog, session, Reactivity.layer)]],
      });
      registry.mount(setRoundStartAtom);
      const target = {
        projectId: 1,
        projectFullPath: 'demo-group/demo-shop',
        consumerId: 'consumer',
        defaultBranch: 'main',
      };

      registry.set(setRoundStartAtom, { ...target, start: 'reviewer', isOn: true });
      registry.set(setRoundStartAtom, { ...target, start: 'push', isOn: true });
      yield* AtomRegistry.getResult(registry, setRoundStartAtom, { suspendOnWaiting: true });

      expect(roundStartsOf(eventTypes)).toEqual(new Set(['opened', 'reviewer', 'push']));
    }),
  );
});
