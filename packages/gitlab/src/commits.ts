import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Schema from 'effect/Schema';
import { checkStatus, GITLAB_BASE_URL, type GitLabRequestFailed, gitLabClient } from './gitlab';

export type GitLabCommitFile = {
  readonly path: string;
  readonly content: string;
  readonly action: 'create' | 'update';
  // The commit that last changed the file as the caller read it: GitLab refuses the commit if the
  // file has changed since, instead of overwriting the newer change.
  readonly lastCommitId?: string;
};

export type GitLabCommit = {
  readonly id: string;
  readonly webUrl: string;
};

const CommitResponseSchema = Schema.Struct({
  id: Schema.String,
  web_url: Schema.String,
});

const projectPath = (projectId: string) => `/api/v4/projects/${encodeURIComponent(projectId)}`;

export class GitLabCommits extends Context.Service<
  GitLabCommits,
  {
    /**
     * Commits files onto `branch`. With `startSha` the branch is created from that commit;
     * without it the commit lands on the branch as it is.
     */
    readonly commit: (args: {
      readonly projectId: string;
      readonly branch: string;
      readonly startSha?: string;
      readonly message: string;
      readonly files: readonly GitLabCommitFile[];
    }) => Effect.Effect<GitLabCommit, GitLabRequestFailed>;
  }
>()('@codetinder/gitlab/GitLabCommits') {
  static readonly layer = Layer.effect(
    GitLabCommits,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String('GITLAB_BASE_URL').pipe(
        Config.withDefault(GITLAB_BASE_URL),
      );
      const token = yield* Config.Redacted('GITLAB_TOKEN');

      const http = gitLabClient(yield* HttpClient.HttpClient, baseUrl, token);

      const commit = Effect.fn('GitLabCommits.commit')(function* ({
        projectId,
        branch,
        startSha,
        message,
        files,
      }: {
        readonly projectId: string;
        readonly branch: string;
        readonly startSha?: string;
        readonly message: string;
        readonly files: readonly GitLabCommitFile[];
      }) {
        const path = `${projectPath(projectId)}/repository/commits`;
        const response = yield* HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            branch,
            ...(startSha === undefined ? {} : { start_sha: startSha }),
            commit_message: message,
            actions: files.map(file => ({
              action: file.action,
              file_path: file.path,
              content: file.content,
              ...(file.lastCommitId === undefined ? {} : { last_commit_id: file.lastCommitId }),
            })),
          }),
          http.execute,
          Effect.orDie,
        );

        yield* checkStatus(response, 'POST', path);

        const created = yield* HttpClientResponse.schemaBodyJson(CommitResponseSchema)(
          response,
        ).pipe(Effect.orDie);

        return { id: created.id, webUrl: created.web_url };
      });

      return GitLabCommits.of({ commit });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
