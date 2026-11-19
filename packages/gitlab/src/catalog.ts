import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import { catalogGraphql, type GitLabCatalogError } from './catalog-graphql';
import { consumerTriggerMethods, type GitLabFlowTriggers } from './consumer-triggers';
import { flowConsumerMethods } from './flow-consumer';
import type { TriggerFilter } from './flow-triggers';
import { gitLabInteractiveClient } from './gitlab';
import { type GitLabProjectSetup, setupStatusMethods } from './setup-status';
import type { InvalidToken } from './users';

export class GitLabCatalog extends Context.Service<
  GitLabCatalog,
  {
    readonly setupStatuses: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectFullPaths: readonly string[];
      readonly configPath: string;
    }) => Effect.Effect<
      { readonly latestVersion: string; readonly projects: readonly GitLabProjectSetup[] },
      GitLabCatalogError | InvalidToken
    >;

    readonly enable: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => Effect.Effect<{ readonly consumerId: string }, GitLabCatalogError | InvalidToken>;

    readonly update: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly consumerId: string;
      readonly version: string;
    }) => Effect.Effect<{ readonly consumerId: string }, GitLabCatalogError | InvalidToken>;

    /** The consumer's triggers, and whether the project has a CI config. */
    readonly flowTriggers: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectFullPath: string;
      readonly consumerId: string;
    }) => Effect.Effect<GitLabFlowTriggers, GitLabCatalogError | InvalidToken>;

    /**
     * Adds a trigger to the consumer, running as `serviceAccountId`; a refusal carries GitLab's
     * reason.
     */
    readonly createTrigger: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectFullPath: string;
      readonly consumerId: string;
      readonly serviceAccountId: string;
      readonly description: string;
      readonly eventTypes: readonly number[];
      readonly filter: TriggerFilter;
    }) => Effect.Effect<{ readonly triggerId: string }, GitLabCatalogError | InvalidToken>;

    /** Writes the trigger's events and filter, both whole; a refusal carries GitLab's reason. */
    readonly updateTrigger: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly triggerId: string;
      readonly eventTypes: readonly number[];
      readonly filter: TriggerFilter;
    }) => Effect.Effect<void, GitLabCatalogError | InvalidToken>;

    /** Deletes one trigger; a refusal carries GitLab's reason. */
    readonly deleteTrigger: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly triggerId: string;
    }) => Effect.Effect<void, GitLabCatalogError | InvalidToken>;

    /** Turns the flow off in a project: its trigger and service account go with the consumer. */
    readonly disable: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly consumerId: string;
    }) => Effect.Effect<void, GitLabCatalogError | InvalidToken>;
  }
>()('@codetinder/gitlab/GitLabCatalog') {
  static readonly layer = Layer.effect(
    GitLabCatalog,
    Effect.gen(function* () {
      const graphql = catalogGraphql(gitLabInteractiveClient(yield* HttpClient.HttpClient));
      return GitLabCatalog.of({
        ...setupStatusMethods(graphql),
        ...flowConsumerMethods(graphql),
        ...consumerTriggerMethods(graphql),
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
