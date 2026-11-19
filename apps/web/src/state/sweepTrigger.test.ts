import { GitLabCatalog, GitLabSweepPage } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { FlowTriggerMissing, startSweep, writeSweepTrigger } from './atoms';

const SWEEP_TRIGGER_ID = 'gid://gitlab/Ai::FlowTrigger/4';
const SERVICE_ACCOUNT_ID = 'gid://gitlab/User/31000001';
const CONSUMER_ID = 'gid://gitlab/Ai::Catalog::ItemConsumer/1';
const SWEEP_TRIGGER = { id: SWEEP_TRIGGER_ID, isAutomatic: false };
const RACED_TRIGGER_ID = 'gid://gitlab/Ai::FlowTrigger/5';

const target = {
  token: Redacted.make('oauth-token'),
  projectFullPath: 'g/p',
  consumerId: CONSUMER_ID,
  defaultBranch: 'main',
};

const filterFor = (isAutomatic: boolean) => ({
  pipeline_hooks: {
    match: 'all',
    rules: [
      { field: 'object_attributes.ref', operator: 'eq', value: 'main' },
      { field: 'object_attributes.status', operator: 'eq', value: 'success' },
      ...(isAutomatic ? [] : [{ field: 'object_attributes.source', operator: 'eq', value: 'api' }]),
    ],
  },
});

/** What a sweep write does to GitLab, given the project's triggers: each call, in order. */
const callsFor = <A, E>(
  effect: Effect.Effect<A, E, GitLabCatalog | GitLabSweepPage>,
  {
    sweeps,
    hasServiceAccount = true,
  }: {
    readonly sweeps: ReadonlyArray<{ readonly id: string; readonly isAutomatic: boolean }>;
    readonly hasServiceAccount?: boolean;
  },
) =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const record =
      (name: string) =>
      ({ token: _token, ...rest }: { readonly token: unknown }) =>
        Effect.sync(() => {
          calls.push({ [name]: rest });
        });
    const notUsed = () => Effect.die(new Error('not used by a sweep'));
    const result = yield* Effect.result(
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              GitLabCatalog,
              GitLabCatalog.of({
                setupStatuses: notUsed,
                enable: notUsed,
                update: notUsed,
                disable: notUsed,
                flowTriggers: () =>
                  Effect.succeed({
                    round: Option.some({
                      id: 'gid://gitlab/Ai::FlowTrigger/3',
                      eventTypes: [6, 0],
                    }),
                    sweeps,
                    serviceAccountId: hasServiceAccount
                      ? Option.some(SERVICE_ACCOUNT_ID)
                      : Option.none(),
                    serviceAccountUsername: Option.none(),
                    hasCiConfig: true,
                  }),
                createTrigger: args =>
                  record('createTrigger')(args).pipe(Effect.as({ triggerId: SWEEP_TRIGGER_ID })),
                updateTrigger: record('updateTrigger'),
                deleteTrigger: record('deleteTrigger'),
              }),
            ),
            Layer.succeed(
              GitLabSweepPage,
              GitLabSweepPage.of({
                startPipeline: record('startPipeline'),
                compare: notUsed,
                mergeRequest: notUsed,
                sweepSession: notUsed,
              }),
            ),
          ),
        ),
      ),
    );
    return { calls, result };
  });

describe('startSweep', () => {
  it.effect(
    'creates the sweep trigger, off, when the project has none, then starts the pipeline',
    () =>
      Effect.gen(function* () {
        const { calls } = yield* callsFor(startSweep({ ...target, projectId: 42 }), {
          sweeps: [],
        });
        expect(calls).toEqual([
          {
            createTrigger: {
              projectFullPath: 'g/p',
              consumerId: CONSUMER_ID,
              serviceAccountId: SERVICE_ACCOUNT_ID,
              description: 'CodeTinder sweep',
              eventTypes: [3],
              filter: filterFor(false),
            },
          },
          { startPipeline: { projectId: '42', ref: 'main' } },
        ]);
      }),
  );

  it.effect('leaves an existing sweep trigger as it is', () =>
    Effect.gen(function* () {
      const { calls } = yield* callsFor(startSweep({ ...target, projectId: 42 }), {
        sweeps: [SWEEP_TRIGGER],
      });
      expect(calls).toEqual([{ startPipeline: { projectId: '42', ref: 'main' } }]);
    }),
  );

  it.effect('starts nothing when the flow has no service account to run a trigger as', () =>
    Effect.gen(function* () {
      const { calls, result } = yield* callsFor(startSweep({ ...target, projectId: 42 }), {
        sweeps: [],
        hasServiceAccount: false,
      });
      expect(calls).toEqual([]);
      expect(result._tag === 'Failure' && result.failure).toBeInstanceOf(FlowTriggerMissing);
    }),
  );
});

describe('writeSweepTrigger', () => {
  it.effect('rewrites the sweep trigger whole', () =>
    Effect.gen(function* () {
      const { calls } = yield* callsFor(writeSweepTrigger({ ...target, isAutomatic: true }), {
        sweeps: [SWEEP_TRIGGER],
      });
      expect(calls).toEqual([
        {
          updateTrigger: {
            triggerId: SWEEP_TRIGGER_ID,
            eventTypes: [3],
            filter: filterFor(true),
          },
        },
      ]);
    }),
  );

  it.effect('keeps the first of triggers that raced and deletes the rest', () =>
    Effect.gen(function* () {
      const { calls } = yield* callsFor(writeSweepTrigger({ ...target, isAutomatic: false }), {
        sweeps: [SWEEP_TRIGGER, { id: RACED_TRIGGER_ID, isAutomatic: true }],
      });
      expect(calls).toEqual([
        {
          updateTrigger: {
            triggerId: SWEEP_TRIGGER_ID,
            eventTypes: [3],
            filter: filterFor(false),
          },
        },
        { deleteTrigger: { triggerId: RACED_TRIGGER_ID } },
      ]);
    }),
  );

  it.effect('creates it, as set, when the project has none', () =>
    Effect.gen(function* () {
      const { calls } = yield* callsFor(writeSweepTrigger({ ...target, isAutomatic: true }), {
        sweeps: [],
      });
      expect(calls).toEqual([
        {
          createTrigger: {
            projectFullPath: 'g/p',
            consumerId: CONSUMER_ID,
            serviceAccountId: SERVICE_ACCOUNT_ID,
            description: 'CodeTinder sweep',
            eventTypes: [3],
            filter: filterFor(true),
          },
        },
      ]);
    }),
  );
});
