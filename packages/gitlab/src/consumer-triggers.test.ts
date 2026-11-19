import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { GitLabCatalog } from './catalog';
import { GitLabCatalogError } from './catalog-graphql';

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

const CONSUMER_ID = 'gid://gitlab/Ai::Catalog::ItemConsumer/12534233';
const SERVICE_ACCOUNT_ID = 'gid://gitlab/User/31000001';
const SERVICE_ACCOUNT_USERNAME = 'ai-codetinder-group';

type TriggerNode = {
  readonly id: string;
  readonly eventTypes: number[];
  readonly consumer: string;
  readonly filter?: unknown;
  readonly userId?: string;
};

const FOUNDATIONAL_TRIGGER: TriggerNode = {
  id: 'gid://gitlab/Ai::FlowTrigger/2',
  eventTypes: [1, 0],
  consumer: 'gid://gitlab/Ai::Catalog::ItemConsumer/1',
  userId: 'gid://gitlab/User/5',
};
const ROUND_TRIGGER: TriggerNode = {
  id: 'gid://gitlab/Ai::FlowTrigger/3',
  eventTypes: [6, 0],
  consumer: CONSUMER_ID,
  userId: SERVICE_ACCOUNT_ID,
};
const sweepNode = (rules: readonly unknown[]): TriggerNode => ({
  id: 'gid://gitlab/Ai::FlowTrigger/4',
  eventTypes: [3],
  consumer: CONSUMER_ID,
  filter: { pipeline_hooks: { match: 'all', rules } },
  userId: SERVICE_ACCOUNT_ID,
});
const SWEEP_RULES = [
  { field: 'object_attributes.ref', operator: 'eq', value: 'main' },
  { field: 'object_attributes.status', operator: 'eq', value: 'success' },
];
const SWEEP_NOW_RULE = { field: 'object_attributes.source', operator: 'eq', value: 'api' };

/** The project as the flow triggers query answers it. */
const triggerProject = ({
  ciConfigPath = '.gitlab-ci.yml',
  ciBlobs = ['.gitlab-ci.yml'],
  triggers = [FOUNDATIONAL_TRIGGER, ROUND_TRIGGER],
}: {
  readonly ciConfigPath?: string;
  readonly ciBlobs?: readonly string[];
  readonly triggers?: readonly TriggerNode[];
}) => ({
  data: {
    project: {
      ciConfigPathOrDefault: ciConfigPath,
      repository: { blobs: { nodes: ciBlobs.map(path => ({ path })) } },
      aiFlowTriggers: {
        nodes: triggers.map(({ id, eventTypes, consumer, filter = {}, userId }) => ({
          id,
          eventTypes,
          filter,
          user: userId === undefined ? null : { id: userId, username: SERVICE_ACCOUNT_USERNAME },
          aiCatalogItemConsumer: { id: consumer },
        })),
      },
    },
  },
});

describe('GitLabCatalog.flowTriggers', () => {
  const read = (answer: unknown) =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      return yield* catalog.flowTriggers({
        token: Redacted.make('oauth-token'),
        projectFullPath: 'group/demo',
        consumerId: CONSUMER_ID,
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.variables).toEqual({
              fullPath: 'group/demo',
              ciConfigPath: '.gitlab-ci.yml',
            });
            return json(answer);
          }),
        ),
      ),
    );

  it.effect("reads the consumer's round trigger and its service account, not the group's", () =>
    Effect.gen(function* () {
      expect(yield* read(triggerProject({}))).toEqual({
        round: Option.some({ id: 'gid://gitlab/Ai::FlowTrigger/3', eventTypes: [6, 0] }),
        sweeps: [],
        serviceAccountId: Option.some(SERVICE_ACCOUNT_ID),
        serviceAccountUsername: Option.some(SERVICE_ACCOUNT_USERNAME),
        hasCiConfig: true,
      });
    }),
  );

  it.effect('tells the sweep trigger from the round trigger on the same consumer', () =>
    Effect.gen(function* () {
      const sweepFirst = triggerProject({
        triggers: [
          sweepNode([...SWEEP_RULES, SWEEP_NOW_RULE]),
          FOUNDATIONAL_TRIGGER,
          ROUND_TRIGGER,
        ],
      });
      const triggers = yield* read(sweepFirst);
      expect(triggers.round).toEqual(
        Option.some({ id: 'gid://gitlab/Ai::FlowTrigger/3', eventTypes: [6, 0] }),
      );
      expect(triggers.sweeps).toEqual([
        { id: 'gid://gitlab/Ai::FlowTrigger/4', isAutomatic: false },
      ]);
    }),
  );

  it.effect('reads a sweep trigger without Sweep now’s rule as automatic', () =>
    Effect.gen(function* () {
      const answer = triggerProject({ triggers: [ROUND_TRIGGER, sweepNode(SWEEP_RULES)] });
      expect((yield* read(answer)).sweeps).toEqual([
        { id: 'gid://gitlab/Ai::FlowTrigger/4', isAutomatic: true },
      ]);
    }),
  );

  it.effect('reads every sweep trigger when two writes raced to create one', () =>
    Effect.gen(function* () {
      const answer = triggerProject({
        triggers: [
          ROUND_TRIGGER,
          sweepNode([...SWEEP_RULES, SWEEP_NOW_RULE]),
          { ...sweepNode(SWEEP_RULES), id: 'gid://gitlab/Ai::FlowTrigger/5' },
        ],
      });
      expect((yield* read(answer)).sweeps).toEqual([
        { id: 'gid://gitlab/Ai::FlowTrigger/4', isAutomatic: false },
        { id: 'gid://gitlab/Ai::FlowTrigger/5', isAutomatic: true },
      ]);
    }),
  );

  it.effect('says when the project has no CI config, or the consumer no trigger', () =>
    Effect.gen(function* () {
      expect(yield* read(triggerProject({ ciBlobs: [], triggers: [] }))).toEqual({
        round: Option.none(),
        sweeps: [],
        serviceAccountId: Option.none(),
        serviceAccountUsername: Option.none(),
        hasCiConfig: false,
      });
    }),
  );

  it.effect('takes a project naming its own CI file to have CI', () =>
    Effect.gen(function* () {
      const answer = triggerProject({ ciConfigPath: 'ci/main.yml@group/ci', ciBlobs: [] });
      expect((yield* read(answer)).hasCiConfig).toBe(true);
    }),
  );
});

describe('GitLabCatalog.createTrigger', () => {
  const create = (answer: unknown) =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      return yield* catalog.createTrigger({
        token: Redacted.make('oauth-token'),
        projectFullPath: 'group/demo',
        consumerId: CONSUMER_ID,
        serviceAccountId: SERVICE_ACCOUNT_ID,
        description: 'CodeTinder sweep',
        eventTypes: [3],
        filter: {},
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.query).toContain('aiFlowTriggerCreate');
            expect(body.variables.input).toEqual({
              projectPath: 'group/demo',
              aiCatalogItemConsumerId: CONSUMER_ID,
              userId: SERVICE_ACCOUNT_ID,
              description: 'CodeTinder sweep',
              eventTypes: [3],
              filter: {},
            });
            return json(answer);
          }),
        ),
      ),
    );

  it.effect("adds a trigger to the consumer, as the flow's service account", () =>
    Effect.gen(function* () {
      expect(
        yield* create({
          data: {
            aiFlowTriggerCreate: {
              aiFlowTrigger: { id: 'gid://gitlab/Ai::FlowTrigger/4' },
              errors: [],
            },
          },
        }),
      ).toEqual({ triggerId: 'gid://gitlab/Ai::FlowTrigger/4' });
    }),
  );

  it.effect("fails with GitLab's reason when it refuses", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        create({
          data: {
            aiFlowTriggerCreate: { aiFlowTrigger: null, errors: ['You do not have permission'] },
          },
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('You do not have permission');
    }),
  );
});

describe('GitLabCatalog.updateTrigger', () => {
  const update = (answer: unknown) =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      return yield* catalog.updateTrigger({
        token: Redacted.make('oauth-token'),
        triggerId: 'gid://gitlab/Ai::FlowTrigger/3',
        eventTypes: [2, 0],
        filter: {},
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.query).toContain('aiFlowTriggerUpdate');
            expect(body.variables.input).toEqual({
              id: 'gid://gitlab/Ai::FlowTrigger/3',
              eventTypes: [2, 0],
              filter: {},
            });
            return json(answer);
          }),
        ),
      ),
    );

  it.effect('writes the events and the filter together', () =>
    update({ data: { aiFlowTriggerUpdate: { errors: [] } } }),
  );

  it.effect("fails with GitLab's reason when it refuses", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        update({
          data: { aiFlowTriggerUpdate: { errors: ['Filter must be a valid json schema'] } },
        }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('Filter must be a valid json schema');
    }),
  );
});

describe('GitLabCatalog.deleteTrigger', () => {
  const remove = (answer: unknown) =>
    Effect.gen(function* () {
      const catalog = yield* GitLabCatalog;
      return yield* catalog.deleteTrigger({
        token: Redacted.make('oauth-token'),
        triggerId: 'gid://gitlab/Ai::FlowTrigger/5',
      });
    }).pipe(
      Effect.provide(
        withCatalog(
          scriptedFetch(async request => {
            const body = await request.json();
            expect(body.query).toContain('aiFlowTriggerDelete');
            expect(body.variables.input).toEqual({ id: 'gid://gitlab/Ai::FlowTrigger/5' });
            return json(answer);
          }),
        ),
      ),
    );

  it.effect('deletes the one trigger', () =>
    remove({ data: { aiFlowTriggerDelete: { errors: [] } } }),
  );

  it.effect("fails with GitLab's reason when it refuses", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        remove({ data: { aiFlowTriggerDelete: { errors: ['Not allowed'] } } }),
      );
      expect(error).toBeInstanceOf(GitLabCatalogError);
      expect(error.message).toBe('Not allowed');
    }),
  );
});
