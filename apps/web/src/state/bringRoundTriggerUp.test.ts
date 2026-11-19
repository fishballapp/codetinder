import { GitLabCatalog } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { bringRoundTriggerUp } from './atoms';

const TRIGGER_ID = 'gid://gitlab/Ai::FlowTrigger/3';

/** The writes Update makes to a project whose trigger has `eventTypes`, or none. */
const writesFor = (eventTypes: readonly number[] | undefined) =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    yield* bringRoundTriggerUp({
      token: Redacted.make('oauth-token'),
      consumerId: 'gid://gitlab/Ai::Catalog::ItemConsumer/1',
      projectFullPath: 'g/p',
      defaultBranch: 'main',
    }).pipe(
      Effect.provide(
        Layer.succeed(
          GitLabCatalog,
          GitLabCatalog.of({
            setupStatuses: () => Effect.die(new Error('not used by Update')),
            enable: () => Effect.die(new Error('not used by Update')),
            update: () => Effect.die(new Error('not used by Update')),
            disable: () => Effect.die(new Error('not used by Update')),
            createTrigger: () => Effect.die(new Error('not used by Update')),
            deleteTrigger: () => Effect.die(new Error('not used by Update')),
            flowTriggers: () =>
              Effect.succeed({
                round: Option.fromNullishOr(eventTypes && { id: TRIGGER_ID, eventTypes }),
                sweeps: [],
                serviceAccountId: Option.none(),
                serviceAccountUsername: Option.none(),
                hasCiConfig: true,
              }),
            updateTrigger: write => Effect.sync(() => void writes.push(write)),
          }),
        ),
      ),
    );
    return writes;
  });

describe('bringRoundTriggerUp', () => {
  it.effect('gives a trigger from before the setting the ready event too', () =>
    Effect.gen(function* () {
      expect(yield* writesFor([6, 0])).toEqual([
        {
          token: expect.anything(),
          triggerId: TRIGGER_ID,
          eventTypes: [6, 4, 0],
          filter: {
            merge_request: {
              match: 'all',
              rules: [{ field: 'action', operator: 'eq', value: 'created' }],
            },
          },
        },
      ]);
    }),
  );

  it.effect('leaves a current trigger, or a missing one, alone', () =>
    Effect.gen(function* () {
      expect(yield* writesFor([6, 4, 2, 0])).toEqual([]);
      expect(yield* writesFor([2, 3, 0])).toEqual([]);
      expect(yield* writesFor(undefined)).toEqual([]);
    }),
  );
});
