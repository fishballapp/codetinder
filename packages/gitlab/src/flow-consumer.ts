import * as Effect from 'effect/Effect';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { type CatalogGraphql, GitLabCatalogError } from './catalog-graphql';
import { CATALOG_ITEM_ID } from './catalog-item';
import { repeatable } from './gitlab';
import { DEFAULT_TRIGGER_CONDITIONS, DEFAULT_TRIGGER_TYPES } from './round-triggers';

const ENABLE_MUTATION = `
mutation EnableCodeTinderFlow($input: AiCatalogItemConsumerCreateInput!) {
  aiCatalogItemConsumerCreate(input: $input) {
    itemConsumer {
      id
    }
    errors
  }
}
`;

const UPDATE_MUTATION = `
mutation UpdateCodeTinderFlowConsumer($input: AiCatalogItemConsumerUpdateInput!) {
  aiCatalogItemConsumerUpdate(input: $input) {
    itemConsumer {
      id
    }
    errors
  }
}
`;

// Deleting the consumer also removes its trigger and service account, which deleting the flow
// itself does not.
const DISABLE_MUTATION = `
mutation DisableCodeTinderFlow($input: AiCatalogItemConsumerDeleteInput!) {
  aiCatalogItemConsumerDelete(input: $input) {
    success
    errors
  }
}
`;

/** What creating or updating a consumer answers. */
const ConsumerPayloadSchema = Schema.NullOr(
  Schema.Struct({
    itemConsumer: Schema.NullOr(Schema.Struct({ id: Schema.String })),
    errors: Schema.Array(Schema.String),
  }),
);

/** `GitLabCatalog`'s writes of the `codetinder` flow's consumer: the flow turned on in a project. */
export const flowConsumerMethods = (graphql: CatalogGraphql) => {
  const enable = Effect.fn('GitLabCatalog.enable')(function* ({
    token,
    projectId,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly projectId: string;
  }) {
    const { aiCatalogItemConsumerCreate } = yield* graphql({
      token,
      query: ENABLE_MUTATION,
      variables: {
        input: {
          itemId: CATALOG_ITEM_ID,
          target: { projectId: `gid://gitlab/Project/${projectId}` },
          triggerTypes: DEFAULT_TRIGGER_TYPES,
          triggerConditions: DEFAULT_TRIGGER_CONDITIONS,
        },
      },
      data: Schema.Struct({ aiCatalogItemConsumerCreate: ConsumerPayloadSchema }),
      mutationErrors: ({ aiCatalogItemConsumerCreate }) => aiCatalogItemConsumerCreate?.errors,
    });

    const consumerId = aiCatalogItemConsumerCreate?.itemConsumer?.id;
    if (consumerId === undefined) {
      return yield* new GitLabCatalogError({ message: 'GitLab failed to create item consumer' });
    }
    return { consumerId };
  });

  const update = Effect.fn('GitLabCatalog.update')(function* ({
    token,
    consumerId,
    version,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly consumerId: string;
    readonly version: string;
  }) {
    // Sets the pinned version, so sending it again sets it again.
    const { aiCatalogItemConsumerUpdate } = yield* graphql({
      token,
      query: UPDATE_MUTATION,
      variables: { input: { id: consumerId, pinnedVersion: version } },
      data: Schema.Struct({ aiCatalogItemConsumerUpdate: ConsumerPayloadSchema }),
      mutationErrors: ({ aiCatalogItemConsumerUpdate }) => aiCatalogItemConsumerUpdate?.errors,
    }).pipe(repeatable);

    const updatedId = aiCatalogItemConsumerUpdate?.itemConsumer?.id;
    if (updatedId === undefined) {
      return yield* new GitLabCatalogError({ message: 'GitLab failed to update item consumer' });
    }
    return { consumerId: updatedId };
  });

  const disable = Effect.fn('GitLabCatalog.disable')(function* ({
    token,
    consumerId,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly consumerId: string;
  }) {
    const { aiCatalogItemConsumerDelete } = yield* graphql({
      token,
      query: DISABLE_MUTATION,
      variables: { input: { id: consumerId } },
      data: Schema.Struct({
        aiCatalogItemConsumerDelete: Schema.NullOr(
          Schema.Struct({ success: Schema.Boolean, errors: Schema.Array(Schema.String) }),
        ),
      }),
      mutationErrors: ({ aiCatalogItemConsumerDelete }) => aiCatalogItemConsumerDelete?.errors,
    });

    if (aiCatalogItemConsumerDelete?.success !== true) {
      return yield* new GitLabCatalogError({ message: 'GitLab failed to delete item consumer' });
    }
  });

  return { enable, update, disable };
};
