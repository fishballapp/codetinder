import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { gitLabInteractiveClient, paginateGitLab } from './gitlab';
import { InvalidToken } from './users';

const ProjectResponseSchema = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  path_with_namespace: Schema.String,
  // null for an empty repository
  default_branch: Schema.NullOr(Schema.String),
});

export type GitLabProject = {
  readonly id: number;
  readonly name: string;
  readonly fullPath: string;
  readonly defaultBranch: string | null;
};

export class GitLabProjects extends Context.Service<
  GitLabProjects,
  {
    /**
     * The projects the token's user can push to (Developer or above), most recently active first,
     * leaving out archived ones. Those scheduled for deletion stay: the REST answer misses a
     * deletion scheduled on an ancestor group, so `setupStatuses` (catalog) reads that instead.
     */
    readonly listWritable: (
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<readonly GitLabProject[], InvalidToken>;
  }
>()('@codetinder/gitlab/GitLabProjects') {
  static readonly layer = Layer.effect(
    GitLabProjects,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const listWritable = Effect.fn('GitLabProjects.listWritable')(
        (token: Redacted.Redacted<string>) =>
          paginateGitLab(page =>
            Effect.gen(function* () {
              const response = yield* HttpClientRequest.get('/api/v4/projects').pipe(
                HttpClientRequest.setUrlParams({
                  min_access_level: '30',
                  membership: 'true',
                  archived: 'false',
                  per_page: '100',
                  page: String(page),
                  order_by: 'last_activity_at',
                }),
                HttpClientRequest.bearerToken(token),
                http.execute,
                Effect.orDie,
              );

              if (response.status === 401 || response.status === 403) {
                return yield* new InvalidToken({ message: 'GitLab rejected the token' });
              }
              if (response.status !== 200) {
                return yield* Effect.die(
                  new Error(`GitLab /projects unexpected status ${response.status}`),
                );
              }

              const projects = yield* HttpClientResponse.schemaBodyJson(
                Schema.Array(ProjectResponseSchema),
              )(response).pipe(Effect.orDie);
              const items = projects.map(project => ({
                id: project.id,
                name: project.name,
                fullPath: project.path_with_namespace,
                defaultBranch: project.default_branch,
              }));

              return { items, response };
            }),
          ),
      );

      return GitLabProjects.of({ listWritable });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
