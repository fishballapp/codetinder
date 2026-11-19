import * as Arr from 'effect/Array';
import * as Effect from 'effect/Effect';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { type CatalogGraphql, GitLabCatalogError } from './catalog-graphql';
import { CATALOG_ITEM_ID } from './catalog-item';
import { repeatable } from './gitlab';
import { REMOVAL_BRANCH } from './removal';
import { SETUP_BRANCH } from './setup';

/**
 * Projects per status request. GitLab refuses more than 50 `fullPaths` in one query, and resolves
 * a consumer's `pinnedItemVersion` for at most 20 per query.
 */
const SETUP_STATUS_PAGE_SIZE = 20;

/** Status requests in flight at once. */
const SETUP_STATUS_CONCURRENCY = 4;

export type GitLabProjectSetup = {
  readonly fullPath: string;
  /** The enabled `codetinder` flow in this project, or null when it isn't enabled. */
  readonly consumer: { readonly id: string; readonly pinnedVersion: string | null } | null;
  /** The open "Add CodeTinder" MR from `codetinder/setup` (SETUP_BRANCH in ./setup), if any. */
  readonly setupMergeRequestUrl: string | null;
  /** The open "Remove CodeTinder" MR from `codetinder/remove` (REMOVAL_BRANCH in ./removal), if any. */
  readonly removalMergeRequest: { readonly iid: string; readonly url: string } | null;
  /** Whether `configPath` exists on the project's default branch. */
  readonly hasConfig: boolean;
  /** The project, or an ancestor group, is scheduled for deletion. */
  readonly isMarkedForDeletion: boolean;
  /** The token's user may turn the `codetinder` flow on in this project. */
  readonly canEnableFlow: boolean;
};

const SETUP_STATUSES_QUERY = `
query CodeTinderSetupStatuses($fullPaths: [String!], $itemId: AiCatalogItemID!, $configPath: String!, $setupBranch: String!, $removalBranch: String!) {
  projects(fullPaths: $fullPaths, first: 50) {
    nodes {
      fullPath
      markedForDeletion
      userPermissions {
        adminAiCatalogItemConsumer
      }
      aiCatalogItemConsumerForItem(id: $itemId) {
        id
        pinnedItemVersion {
          versionName
        }
      }
      setupMergeRequests: mergeRequests(sourceBranches: [$setupBranch], state: opened, first: 1) {
        nodes {
          webUrl
        }
      }
      removalMergeRequests: mergeRequests(sourceBranches: [$removalBranch], state: opened, first: 1) {
        nodes {
          iid
          webUrl
        }
      }
      repository {
        blobs(paths: [$configPath]) {
          nodes {
            path
          }
        }
      }
    }
  }
  aiCatalogItem(id: $itemId) {
    latestVersion {
      versionName
    }
  }
}
`;

const SetupStatusNodeSchema = Schema.Struct({
  fullPath: Schema.String,
  markedForDeletion: Schema.Boolean,
  userPermissions: Schema.Struct({
    adminAiCatalogItemConsumer: Schema.Boolean,
  }),
  aiCatalogItemConsumerForItem: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      pinnedItemVersion: Schema.NullOr(Schema.Struct({ versionName: Schema.String })),
    }),
  ),
  setupMergeRequests: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ webUrl: Schema.String })),
  }),
  removalMergeRequests: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ iid: Schema.String, webUrl: Schema.String })),
  }),
  repository: Schema.NullOr(
    Schema.Struct({
      blobs: Schema.NullOr(
        Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ path: Schema.String })),
        }),
      ),
    }),
  ),
});
type SetupStatusNode = typeof SetupStatusNodeSchema.Type;

const SetupStatusesDataSchema = Schema.Struct({
  projects: Schema.Struct({
    nodes: Schema.Array(SetupStatusNodeSchema),
  }),
  aiCatalogItem: Schema.NullOr(
    Schema.Struct({
      latestVersion: Schema.NullOr(Schema.Struct({ versionName: Schema.String })),
    }),
  ),
});

const toProjectSetup = (
  {
    fullPath,
    markedForDeletion,
    userPermissions,
    aiCatalogItemConsumerForItem,
    setupMergeRequests,
    removalMergeRequests,
    repository,
  }: SetupStatusNode,
  configPath: string,
): GitLabProjectSetup => {
  const removalMergeRequest = removalMergeRequests.nodes[0];
  return {
    fullPath,
    consumer:
      aiCatalogItemConsumerForItem === null
        ? null
        : {
            id: aiCatalogItemConsumerForItem.id,
            pinnedVersion: aiCatalogItemConsumerForItem.pinnedItemVersion?.versionName ?? null,
          },
    setupMergeRequestUrl: setupMergeRequests.nodes[0]?.webUrl ?? null,
    removalMergeRequest:
      removalMergeRequest === undefined
        ? null
        : { iid: removalMergeRequest.iid, url: removalMergeRequest.webUrl },
    hasConfig: repository?.blobs?.nodes.some(({ path }) => path === configPath) ?? false,
    isMarkedForDeletion: markedForDeletion,
    canEnableFlow: userPermissions.adminAiCatalogItemConsumer,
  };
};

/** `GitLabCatalog`'s read of whether, and how far, CodeTinder is set up in each project. */
export const setupStatusMethods = (graphql: CatalogGraphql) => {
  const setupStatusesPage = Effect.fn('GitLabCatalog.setupStatusesPage')(function* ({
    token,
    projectFullPaths,
    configPath,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly projectFullPaths: readonly string[];
    readonly configPath: string;
  }) {
    const { projects, aiCatalogItem } = yield* graphql({
      token,
      query: SETUP_STATUSES_QUERY,
      variables: {
        fullPaths: projectFullPaths,
        itemId: CATALOG_ITEM_ID,
        setupBranch: SETUP_BRANCH,
        removalBranch: REMOVAL_BRANCH,
        configPath,
      },
      data: SetupStatusesDataSchema,
    }).pipe(repeatable);

    const latestVersion = aiCatalogItem?.latestVersion?.versionName;
    if (latestVersion === undefined) {
      return yield* new GitLabCatalogError({
        message: 'Catalog item or latest version not found',
      });
    }
    return { latestVersion, nodes: projects.nodes };
  });

  const setupStatuses = Effect.fn('GitLabCatalog.setupStatuses')(function* ({
    token,
    projectFullPaths,
    configPath,
  }: {
    readonly token: Redacted.Redacted<string>;
    readonly projectFullPaths: readonly string[];
    readonly configPath: string;
  }) {
    // No projects still needs one request: it is what returns the catalog's latest version.
    const pagesOfPaths =
      projectFullPaths.length === 0 ? [[]] : Arr.chunksOf(projectFullPaths, SETUP_STATUS_PAGE_SIZE);
    const pages = yield* Effect.forEach(
      pagesOfPaths,
      fullPaths => setupStatusesPage({ token, projectFullPaths: fullPaths, configPath }),
      { concurrency: SETUP_STATUS_CONCURRENCY },
    );

    const [firstPage] = pages;
    if (firstPage === undefined) {
      return yield* Effect.die(new Error('setupStatuses made no page request'));
    }

    const setupsByPath = new Map(
      pages
        .flatMap(({ nodes }) => nodes)
        .map(node => [node.fullPath, toProjectSetup(node, configPath)] as const),
    );
    // GitLab answers in its own order and leaves out a project the token can't see.
    const projects = projectFullPaths.flatMap(fullPath => setupsByPath.get(fullPath) ?? []);
    return { latestVersion: firstPage.latestVersion, projects };
  });

  return { setupStatuses };
};
