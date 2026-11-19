import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { type CatalogGraphql, GitLabCatalogError } from './catalog-graphql';
import { StoredTriggerFilterSchema, type TriggerFilter } from './flow-triggers';
import { repeatable } from './gitlab';
import { isSweepAutomatic, isSweepTrigger } from './sweep-trigger';

/**
 * The `codetinder` flow's triggers in a project, and whether the project has the CI a pipeline
 * event needs (a round on a push, a sweep).
 */
export type GitLabFlowTriggers = {
  /** The trigger rounds start on; none when someone deleted it in GitLab. */
  readonly round: Option.Option<{ readonly id: string; readonly eventTypes: readonly number[] }>;
  /**
   * The sweep's triggers: none until sweeping is turned on or Sweep now is first pressed, and more
   * than one only when two writes raced to create it.
   */
  readonly sweeps: ReadonlyArray<{ readonly id: string; readonly isAutomatic: boolean }>;
  /** The flow's service account (the round trigger runs as it), which a new trigger runs as too. */
  readonly serviceAccountId: Option.Option<string>;
  /** Its username: mentioning it in a merge request reaches the flow. */
  readonly serviceAccountUsername: Option.Option<string>;
  readonly hasCiConfig: boolean;
};

/** Where GitLab looks for a project's CI config unless the project names another file. */
const DEFAULT_CI_CONFIG_PATH = '.gitlab-ci.yml';

// The group's foundational trigger is in the same list: ours are the ones on our consumer.
const FLOW_TRIGGERS_QUERY = `
query CodeTinderFlowTriggers($fullPath: ID!, $ciConfigPath: String!) {
  project(fullPath: $fullPath) {
    ciConfigPathOrDefault
    repository {
      blobs(paths: [$ciConfigPath]) {
        nodes {
          path
        }
      }
    }
    aiFlowTriggers {
      nodes {
        id
        eventTypes
        filter
        user {
          id
          username
        }
        aiCatalogItemConsumer {
          id
        }
      }
    }
  }
}
`;

const TRIGGER_CREATE_MUTATION = `
mutation CreateCodeTinderTrigger($input: AiFlowTriggerCreateInput!) {
  aiFlowTriggerCreate(input: $input) {
    aiFlowTrigger {
      id
    }
    errors
  }
}
`;

const TRIGGER_UPDATE_MUTATION = `
mutation UpdateCodeTinderTrigger($input: AiFlowTriggerUpdateInput!) {
  aiFlowTriggerUpdate(input: $input) {
    errors
  }
}
`;

const TRIGGER_DELETE_MUTATION = `
mutation DeleteCodeTinderTrigger($input: AiFlowTriggerDeleteInput!) {
  aiFlowTriggerDelete(input: $input) {
    errors
  }
}
`;

const FlowTriggersDataSchema = Schema.Struct({
  project: Schema.NullOr(
    Schema.Struct({
      ciConfigPathOrDefault: Schema.String,
      repository: Schema.NullOr(
        Schema.Struct({
          blobs: Schema.NullOr(
            Schema.Struct({ nodes: Schema.Array(Schema.Struct({ path: Schema.String })) }),
          ),
        }),
      ),
      aiFlowTriggers: Schema.NullOr(
        Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              eventTypes: Schema.Array(Schema.Int),
              filter: Schema.NullOr(Schema.Unknown),
              user: Schema.NullOr(Schema.Struct({ id: Schema.String, username: Schema.String })),
              aiCatalogItemConsumer: Schema.NullOr(Schema.Struct({ id: Schema.String })),
            }),
          ),
        }),
      ),
    }),
  ),
});

/** What updating or deleting a trigger answers. */
const TriggerPayloadSchema = Schema.NullOr(Schema.Struct({ errors: Schema.Array(Schema.String) }));

/** `GitLabCatalog`'s reads and writes of the triggers on the `codetinder` flow's consumer. */
export const consumerTriggerMethods = (graphql: CatalogGraphql) => {
  const flowTriggers = Effect.fn('GitLabCatalog.flowTriggers')(function* ({
    token,
    projectFullPath,
    consumerId,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly projectFullPath: string;
    readonly consumerId: string;
  }) {
    const { project } = yield* graphql({
      token,
      query: FLOW_TRIGGERS_QUERY,
      variables: { fullPath: projectFullPath, ciConfigPath: DEFAULT_CI_CONFIG_PATH },
      data: FlowTriggersDataSchema,
    }).pipe(repeatable);
    if (project === null) {
      return yield* new GitLabCatalogError({ message: `GitLab has no project ${projectFullPath}` });
    }

    const consumerTriggers = (project.aiFlowTriggers?.nodes ?? []).filter(
      ({ aiCatalogItemConsumer }) => aiCatalogItemConsumer?.id === consumerId,
    );
    const round = consumerTriggers.find(({ eventTypes }) => !isSweepTrigger(eventTypes));
    const sweeps = yield* Effect.forEach(
      consumerTriggers.filter(({ eventTypes }) => isSweepTrigger(eventTypes)),
      ({ id, filter }) =>
        Schema.decodeUnknownEffect(StoredTriggerFilterSchema)(filter ?? {}).pipe(
          Effect.map(storedFilter => ({ id, isAutomatic: isSweepAutomatic(storedFilter) })),
          Effect.orDie,
        ),
      { concurrency: 'unbounded' },
    );
    // ponytail: a project that names its own CI file (often in another project) is taken to
    // have CI; checking it would need a second read, and a wrong guess only lets a pipeline
    // event start nothing.
    const hasOwnCiConfigPath = project.ciConfigPathOrDefault !== DEFAULT_CI_CONFIG_PATH;
    const hasDefaultCiConfig = (project.repository?.blobs?.nodes.length ?? 0) > 0;

    return {
      round: Option.fromNullishOr(round).pipe(
        Option.map(({ id, eventTypes }) => ({ id, eventTypes })),
      ),
      sweeps,
      serviceAccountId: Option.fromNullishOr(round?.user?.id),
      serviceAccountUsername: Option.fromNullishOr(round?.user?.username),
      hasCiConfig: hasOwnCiConfigPath || hasDefaultCiConfig,
    };
  });

  const createTrigger = Effect.fn('GitLabCatalog.createTrigger')(function* ({
    token,
    projectFullPath,
    consumerId,
    serviceAccountId,
    description,
    eventTypes,
    filter,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly projectFullPath: string;
    readonly consumerId: string;
    readonly serviceAccountId: string;
    readonly description: string;
    readonly eventTypes: readonly number[];
    readonly filter: TriggerFilter;
  }) {
    const { aiFlowTriggerCreate } = yield* graphql({
      token,
      query: TRIGGER_CREATE_MUTATION,
      variables: {
        input: {
          projectPath: projectFullPath,
          aiCatalogItemConsumerId: consumerId,
          userId: serviceAccountId,
          description,
          eventTypes,
          filter,
        },
      },
      data: Schema.Struct({
        aiFlowTriggerCreate: Schema.NullOr(
          Schema.Struct({
            aiFlowTrigger: Schema.NullOr(Schema.Struct({ id: Schema.String })),
            errors: Schema.Array(Schema.String),
          }),
        ),
      }),
      mutationErrors: ({ aiFlowTriggerCreate }) => aiFlowTriggerCreate?.errors,
    });

    const triggerId = aiFlowTriggerCreate?.aiFlowTrigger?.id;
    if (triggerId === undefined) {
      return yield* new GitLabCatalogError({ message: 'GitLab answered without the trigger' });
    }
    return { triggerId };
  });

  const updateTrigger = Effect.fn('GitLabCatalog.updateTrigger')(function* ({
    token,
    triggerId,
    eventTypes,
    filter,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly triggerId: string;
    readonly eventTypes: readonly number[];
    readonly filter: TriggerFilter;
  }) {
    // Sets the events and the filter, so sending it again sets them again.
    const { aiFlowTriggerUpdate } = yield* graphql({
      token,
      query: TRIGGER_UPDATE_MUTATION,
      variables: { input: { id: triggerId, eventTypes, filter } },
      data: Schema.Struct({ aiFlowTriggerUpdate: TriggerPayloadSchema }),
      mutationErrors: ({ aiFlowTriggerUpdate }) => aiFlowTriggerUpdate?.errors,
    }).pipe(repeatable);

    if (aiFlowTriggerUpdate === null) {
      return yield* new GitLabCatalogError({ message: 'GitLab answered without the trigger' });
    }
  });

  const deleteTrigger = Effect.fn('GitLabCatalog.deleteTrigger')(function* ({
    token,
    triggerId,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly triggerId: string;
  }) {
    const { aiFlowTriggerDelete } = yield* graphql({
      token,
      query: TRIGGER_DELETE_MUTATION,
      variables: { input: { id: triggerId } },
      data: Schema.Struct({ aiFlowTriggerDelete: TriggerPayloadSchema }),
      mutationErrors: ({ aiFlowTriggerDelete }) => aiFlowTriggerDelete?.errors,
    });

    if (aiFlowTriggerDelete === null) {
      return yield* new GitLabCatalogError({ message: 'GitLab answered without the trigger' });
    }
  });

  return { flowTriggers, createTrigger, updateTrigger, deleteTrigger };
};
