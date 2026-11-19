import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { gitLabInteractiveClient } from './gitlab';
import { SETUP_BRANCH } from './setup';

export const REMOVAL_BRANCH = 'codetinder/remove';
export const REMOVAL_TITLE = 'Remove CodeTinder 💔';

const MergeRequestResponseSchema = Schema.Struct({
  iid: Schema.Int,
  web_url: Schema.String,
  source_project_id: Schema.Int,
});

const ErrorMessageSchema = Schema.Struct({
  message: Schema.String,
});

/**
 * The removal's steps on GitLab's side. Each checks what is still there first, so a retry only does
 * what is missing. The branches are CodeTinder's own, so a leftover one is replaced, not reused.
 */
export class GitLabRemoval extends Context.Service<
  GitLabRemoval,
  {
    /** Closes the open "Add CodeTinder" MR on the default branch, if there is one. */
    readonly closeSetupMergeRequest: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly defaultBranch: string;
    }) => Effect.Effect<void>;
    /** Deletes the `codetinder/setup` branch, if it is there, so a later add can open a new one. */
    readonly deleteSetupBranch: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
    }) => Effect.Effect<void>;
    /** Opens "Remove CodeTinder", deleting `configPath` on the default branch; answers its URL. */
    readonly openRemovalMergeRequest: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly defaultBranch: string;
      readonly configPath: string;
      readonly description: string;
    }) => Effect.Effect<string>;
  }
>()('@codetinder/gitlab/GitLabRemoval') {
  static readonly layer = Layer.effect(
    GitLabRemoval,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      /**
       * The project's own open MR from `sourceBranch` into `defaultBranch`. The list also holds MRs
       * from forks that happen to use the same branch name; those are not CodeTinder's.
       */
      const findOpenMergeRequest = Effect.fn('GitLabRemoval.findOpenMergeRequest')(function* ({
        token,
        projectId,
        sourceBranch,
        defaultBranch,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly sourceBranch: string;
        readonly defaultBranch: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
        ).pipe(
          HttpClientRequest.setUrlParams({
            source_branch: sourceBranch,
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
        return mrs.find(mr => mr.source_project_id === Number(projectId));
      });

      /** Deletes a branch of the project; a branch already gone is fine. */
      const deleteBranch = Effect.fn('GitLabRemoval.deleteBranch')(function* ({
        token,
        projectId,
        branch,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly branch: string;
      }) {
        const response = yield* HttpClientRequest.make('DELETE')(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/branches/${encodeURIComponent(branch)}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);
        if (response.status !== 204 && response.status !== 404) {
          return yield* Effect.die(
            new Error(`GitLab /repository/branches unexpected status ${response.status}`),
          );
        }
      });

      const closeSetupMergeRequest = Effect.fn('GitLabRemoval.closeSetupMergeRequest')(function* ({
        token,
        projectId,
        defaultBranch,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly defaultBranch: string;
      }) {
        const setupMergeRequest = yield* findOpenMergeRequest({
          token,
          projectId,
          sourceBranch: SETUP_BRANCH,
          defaultBranch,
        });
        if (setupMergeRequest === undefined) return;

        const closeResponse = yield* HttpClientRequest.put(
          `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${setupMergeRequest.iid}`,
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({ state_event: 'close' }),
          http.execute,
          Effect.orDie,
        );
        if (closeResponse.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /merge_requests/:iid unexpected status ${closeResponse.status}`),
          );
        }
      });

      const deleteSetupBranch = Effect.fn('GitLabRemoval.deleteSetupBranch')(function* ({
        token,
        projectId,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
      }) {
        // Closing an MR keeps its branch, and a branch left behind makes the next add fail.
        yield* deleteBranch({ token, projectId, branch: SETUP_BRANCH });
      });

      /** Commits the config's deletion to the removal branch; false when the branch already exists. */
      const commitRemoval = Effect.fn('GitLabRemoval.commitRemoval')(function* ({
        token,
        projectId,
        defaultBranch,
        configPath,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly defaultBranch: string;
        readonly configPath: string;
      }) {
        const commitResponse = yield* HttpClientRequest.post(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/commits`,
        ).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            branch: REMOVAL_BRANCH,
            start_branch: defaultBranch,
            commit_message: REMOVAL_TITLE,
            actions: [{ action: 'delete', file_path: configPath }],
          }),
          http.execute,
          Effect.orDie,
        );

        if (commitResponse.status === 201) return true;
        if (commitResponse.status !== 400) {
          return yield* Effect.die(
            new Error(`GitLab /repository/commits unexpected status ${commitResponse.status}`),
          );
        }
        const errorBody = yield* HttpClientResponse.schemaBodyJson(ErrorMessageSchema)(
          commitResponse,
        ).pipe(Effect.orDie);
        if (/branch.*already exists/i.test(errorBody.message)) return false;
        return yield* Effect.die(
          new Error(`GitLab /repository/commits failed: ${errorBody.message}`),
        );
      });

      const openRemovalMergeRequest = Effect.fn('GitLabRemoval.openRemovalMergeRequest')(
        function* ({
          token,
          projectId,
          defaultBranch,
          configPath,
          description,
        }: {
          readonly token: Redacted.Redacted<string>;
          readonly projectId: string;
          readonly defaultBranch: string;
          readonly configPath: string;
          readonly description: string;
        }) {
          const commitArgs = { token, projectId, defaultBranch, configPath };
          const isCommitted = yield* commitRemoval(commitArgs);
          if (!isCommitted) {
            // The branch is left from a removal whose MR never opened or was closed: replace it, once.
            const openMergeRequest = yield* findOpenMergeRequest({
              token,
              projectId,
              sourceBranch: REMOVAL_BRANCH,
              defaultBranch,
            });
            if (openMergeRequest !== undefined) return openMergeRequest.web_url;
            yield* deleteBranch({ token, projectId, branch: REMOVAL_BRANCH });
            const isRecommitted = yield* commitRemoval(commitArgs);
            if (!isRecommitted) {
              return yield* Effect.die(
                new Error(`GitLab kept refusing the '${REMOVAL_BRANCH}' branch after deleting it`),
              );
            }
          }

          const mrResponse = yield* HttpClientRequest.post(
            `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`,
          ).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.bodyJsonUnsafe({
              source_branch: REMOVAL_BRANCH,
              target_branch: defaultBranch,
              title: REMOVAL_TITLE,
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
            const openMergeRequest = yield* findOpenMergeRequest({
              token,
              projectId,
              sourceBranch: REMOVAL_BRANCH,
              defaultBranch,
            });
            if (openMergeRequest !== undefined) {
              return openMergeRequest.web_url;
            }
          }

          return yield* Effect.die(
            new Error(`GitLab /merge_requests unexpected status ${mrResponse.status}`),
          );
        },
      );

      return GitLabRemoval.of({
        closeSetupMergeRequest,
        deleteSetupBranch,
        openRemovalMergeRequest,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
