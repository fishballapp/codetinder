import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import {
  checkStatus,
  GITLAB_BASE_URL,
  type GitLabRequestFailed,
  gitLabClient,
  paginateGitLab,
} from './gitlab';

const ProjectResponseSchema = Schema.Struct({
  default_branch: Schema.String,
  web_url: Schema.String,
});

const MergeRequestResponseSchema = Schema.Struct({
  iid: Schema.Int,
  source_branch: Schema.String,
  source_project_id: Schema.NullOr(Schema.Int),
});

/** What a sweep reads of GitLab, as the flow's service account. */
export class GitLabSweeps extends Context.Service<
  GitLabSweeps,
  {
    /** The project's default branch, which a sweep runs on and proposes into, and its web URL. */
    readonly project: (args: {
      readonly projectId: string;
    }) => Effect.Effect<
      { readonly defaultBranch: string; readonly webUrl: string },
      GitLabRequestFailed
    >;
    /** The IIDs of the project's own open MRs from a branch whose name starts with `branchPrefix`. */
    readonly openMergeRequestsFrom: (args: {
      readonly projectId: string;
      readonly branchPrefix: string;
    }) => Effect.Effect<readonly number[], GitLabRequestFailed>;
  }
>()('@codetinder/gitlab/GitLabSweeps') {
  static readonly layer = Layer.effect(
    GitLabSweeps,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String('GITLAB_BASE_URL').pipe(
        Config.withDefault(GITLAB_BASE_URL),
      );
      const token = yield* Config.Redacted('GITLAB_TOKEN');

      const http = gitLabClient(yield* HttpClient.HttpClient, baseUrl, token);
      const projectPath = (projectId: string) =>
        `/api/v4/projects/${encodeURIComponent(projectId)}`;

      const project = Effect.fn('GitLabSweeps.project')(function* ({
        projectId,
      }: {
        readonly projectId: string;
      }) {
        const path = projectPath(projectId);
        const response = yield* HttpClientRequest.get(path).pipe(http.execute, Effect.orDie);
        yield* checkStatus(response, 'GET', path);
        const body = yield* HttpClientResponse.schemaBodyJson(ProjectResponseSchema)(response).pipe(
          Effect.orDie,
        );
        return { defaultBranch: body.default_branch, webUrl: body.web_url };
      });

      /** The project's own merge requests matching `params`, a fork's left out. */
      const listOwn = Effect.fn('GitLabSweeps.listOwn')(function* (
        projectId: string,
        params: Record<string, string>,
      ) {
        const path = `${projectPath(projectId)}/merge_requests`;
        const listed = yield* paginateGitLab(page =>
          Effect.gen(function* () {
            const response = yield* HttpClientRequest.get(path).pipe(
              HttpClientRequest.setUrlParams({ ...params, per_page: '100', page: String(page) }),
              http.execute,
              Effect.orDie,
            );
            yield* checkStatus(response, 'GET', path);
            const items = yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(MergeRequestResponseSchema),
            )(response).pipe(Effect.orDie);
            return { items, response };
          }),
        );
        return listed.filter(({ source_project_id }) => source_project_id === Number(projectId));
      });

      const openMergeRequestsFrom = Effect.fn('GitLabSweeps.openMergeRequestsFrom')(function* ({
        projectId,
        branchPrefix,
      }: {
        readonly projectId: string;
        readonly branchPrefix: string;
      }) {
        const open = yield* listOwn(projectId, { state: 'opened' });
        return open
          .filter(({ source_branch }) => source_branch.startsWith(branchPrefix))
          .map(({ iid }) => iid);
      });

      return GitLabSweeps.of({ project, openMergeRequestsFrom });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
