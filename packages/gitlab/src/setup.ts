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

export class SetupFilesExist extends Schema.TaggedError<SetupFilesExist>()('SetupFilesExist', {
  message: Schema.String,
}) {}

const ProjectResponseSchema = Schema.Struct({
  default_branch: Schema.String,
});

const BranchResponseSchema = Schema.Struct({
  commit: Schema.Struct({ id: Schema.String }),
});

const TreeItemSchema = Schema.Struct({
  name: Schema.String,
});

const MergeRequestResponseSchema = Schema.Struct({
  web_url: Schema.String,
  source_project_id: Schema.Int,
});

const ErrorMessageSchema = Schema.Struct({
  message: Schema.String,
});

/** A file the setup commit adds, or an existing one it rewrites whole. */
export type SetupCommitFile = {
  readonly path: string;
  readonly action: 'create' | 'update';
  readonly content: string;
};

export const SETUP_BRANCH = 'codetinder/setup';
export const SETUP_TITLE = 'Add CodeTinder 💘';

export class GitLabSetup extends Context.Service<
  GitLabSetup,
  {
    readonly defaultBranch: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => Effect.Effect<string>;
    /** The commit `branch` points at now. */
    readonly branchHead: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly branch: string;
    }) => Effect.Effect<string>;
    readonly rootFileNames: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly ref: string;
    }) => Effect.Effect<readonly string[]>;
    /**
     * Commits `files` onto the setup branch, made from `baseSha`, and opens its MR into
     * `defaultBranch`. `baseSha` is the commit an updated file was read at: a change made to it on
     * the default branch since is merged with the MR's, never overwritten by it.
     */
    readonly openSetupMergeRequest: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly defaultBranch: string;
      readonly baseSha: string;
      readonly files: ReadonlyArray<SetupCommitFile>;
      readonly description: string;
    }) => Effect.Effect<string, SetupFilesExist>;
  }
>()('@codetinder/gitlab/GitLabSetup') {
  static readonly layer = Layer.effect(
    GitLabSetup,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const defaultBranch = Effect.fn('GitLabSetup.defaultBranch')(function* ({
        token,
        projectId,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);

        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /projects/:id unexpected status ${response.status}`),
          );
        }

        const body = yield* HttpClientResponse.schemaBodyJson(ProjectResponseSchema)(response).pipe(
          Effect.orDie,
        );
        return body.default_branch;
      });

      const branchHead = Effect.fn('GitLabSetup.branchHead')(function* ({
        token,
        projectId,
        branch,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly branch: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /repository/branches/:branch unexpected status ${response.status}`),
          );
        }
        const body = yield* HttpClientResponse.schemaBodyJson(BranchResponseSchema)(response).pipe(
          Effect.orDie,
        );
        return body.commit.id;
      });

      const rootFileNames = Effect.fn('GitLabSetup.rootFileNames')(
        ({
          token,
          projectId,
          ref,
        }: {
          readonly token: Redacted.Redacted<string>;
          readonly projectId: string;
          readonly ref: string;
        }) =>
          paginateGitLab(page =>
            Effect.gen(function* () {
              const response = yield* HttpClientRequest.get(
                `/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree`,
              ).pipe(
                HttpClientRequest.setUrlParams({ per_page: '100', page: String(page), ref }),
                HttpClientRequest.bearerToken(token),
                http.execute,
                Effect.orDie,
              );
              if (response.status !== 200) {
                return yield* Effect.die(
                  new Error(`GitLab /repository/tree unexpected status ${response.status}`),
                );
              }
              const tree = yield* HttpClientResponse.schemaBodyJson(Schema.Array(TreeItemSchema))(
                response,
              ).pipe(Effect.orDie);
              return { items: tree.map(item => item.name), response };
            }),
          ),
      );

      /**
       * The project's own open setup MR into the default branch. The list also holds MRs from forks
       * that happen to use the same branch name; those are not CodeTinder's.
       */
      const findOpenSetupMr = Effect.fn('GitLabSetup.findOpenSetupMr')(function* (
        token: Redacted.Redacted<string>,
        projectId: string,
        defaultBranch: string,
      ) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            source_branch: SETUP_BRANCH,
            target_branch: defaultBranch,
            state: 'opened',
          }),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );

        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /merge_requests unexpected status ${response.status}`),
          );
        }

        const mrs = yield* HttpClientResponse.schemaBodyJson(
          Schema.Array(MergeRequestResponseSchema),
        )(response).pipe(Effect.orDie);
        return mrs.find(mr => mr.source_project_id === Number(projectId))?.web_url;
      });

      /** Deletes the setup branch; a branch already gone is fine. */
      const deleteSetupBranch = Effect.fn('GitLabSetup.deleteSetupBranch')(function* (
        token: Redacted.Redacted<string>,
        projectId: string,
      ) {
        const response = yield* HttpClientRequest.make('DELETE')(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(SETUP_BRANCH)}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);
        if (response.status !== 204 && response.status !== 404) {
          return yield* Effect.die(
            new Error(`GitLab /repository/branches unexpected status ${response.status}`),
          );
        }
      });

      const openSetupMergeRequest = Effect.fn('GitLabSetup.openSetupMergeRequest')(function* ({
        token,
        projectId,
        defaultBranch,
        baseSha,
        files,
        description,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly defaultBranch: string;
        readonly baseSha: string;
        readonly files: ReadonlyArray<SetupCommitFile>;
        readonly description: string;
      }) {
        const commit = HttpClientRequest.post(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits`,
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            branch: SETUP_BRANCH,
            start_sha: baseSha,
            commit_message: SETUP_TITLE,
            actions: files.map(file => ({
              action: file.action,
              file_path: file.path,
              content: file.content,
            })),
          }),
          http.execute,
          Effect.orDie,
        );
        const refusal = (response: HttpClientResponse.HttpClientResponse) =>
          response.status === 400
            ? HttpClientResponse.schemaBodyJson(ErrorMessageSchema)(response).pipe(
                Effect.orDie,
                Effect.map(({ message }) => message),
              )
            : Effect.succeed(undefined);
        const isBranchTaken = (message: string | undefined) =>
          message !== undefined && /branch.*already exists/i.test(message);

        const attempt = Effect.gen(function* () {
          const response = yield* commit;
          return { response, message: yield* refusal(response) };
        });

        const first = yield* attempt;
        if (isBranchTaken(first.message)) {
          const openMrUrl = yield* findOpenSetupMr(token, projectId, defaultBranch);
          if (openMrUrl !== undefined) {
            return openMrUrl;
          }
          // CodeTinder's own branch, left by a closed setup MR or one that failed to open: replaced.
          yield* deleteSetupBranch(token, projectId);
        }
        const { response: commitResponse, message } = isBranchTaken(first.message)
          ? yield* attempt
          : first;

        if (message !== undefined) {
          if (/file.*already exists/i.test(message)) {
            return yield* new SetupFilesExist({ message });
          }
          return yield* Effect.die(new Error(`GitLab /repository/commits failed: ${message}`));
        }
        if (commitResponse.status !== 201) {
          return yield* Effect.die(
            new Error(`GitLab /repository/commits unexpected status ${commitResponse.status}`),
          );
        }

        const mrResponse = yield* HttpClientRequest.post(
          `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            source_branch: SETUP_BRANCH,
            target_branch: defaultBranch,
            title: SETUP_TITLE,
            description,
            remove_source_branch: true,
          }),
          http.execute,
          Effect.orDie,
        );

        if (mrResponse.status === 201) {
          const mr = yield* HttpClientResponse.schemaBodyJson(MergeRequestResponseSchema)(
            mrResponse,
          ).pipe(Effect.orDie);
          return mr.web_url;
        }

        if (mrResponse.status === 409) {
          const openMrUrl = yield* findOpenSetupMr(token, projectId, defaultBranch);
          if (openMrUrl !== undefined) {
            return openMrUrl;
          }
        }

        return yield* Effect.die(
          new Error(`GitLab /merge_requests unexpected status ${mrResponse.status}`),
        );
      });

      return GitLabSetup.of({ defaultBranch, branchHead, rootFileNames, openSetupMergeRequest });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
