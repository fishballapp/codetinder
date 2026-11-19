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

export type GitLabNote = {
  readonly id: number;
  readonly body: string;
  readonly authorUsername: string;
  readonly isSystem: boolean;
};

export type GitLabDiscussion = {
  readonly id: string;
  readonly notes: readonly GitLabNote[];
};

const DiscussionResponseSchema = Schema.Struct({
  id: Schema.String,
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.Int,
      body: Schema.String,
      author: Schema.Struct({ username: Schema.String }),
      system: Schema.Boolean,
    }),
  ),
});

const NoteResponseSchema = Schema.Struct({
  id: Schema.Int,
});

const mergeRequestPath = (projectId: string, mergeRequestIid: number) =>
  `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mergeRequestIid}`;

export class GitLabDiscussions extends Context.Service<
  GitLabDiscussions,
  {
    /** Every discussion on the merge request, oldest first. */
    readonly list: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly mergeRequestIid: number;
    }) => Effect.Effect<readonly GitLabDiscussion[], InvalidToken>;
    /**
     * Adds a note to a discussion, answering with the new note's id. Replying to an individual
     * note turns it into a thread, which is intended.
     */
    readonly reply: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly discussionId: string;
      readonly body: string;
    }) => Effect.Effect<{ readonly noteId: number }, InvalidToken>;
  }
>()('@codetinder/gitlab/GitLabDiscussions') {
  static readonly layer = Layer.effect(
    GitLabDiscussions,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const list = Effect.fn('GitLabDiscussions.list')(function* ({
        token,
        projectId,
        mergeRequestIid,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly mergeRequestIid: number;
      }) {
        const discussions = yield* paginateGitLab(page =>
          Effect.gen(function* () {
            const response = yield* HttpClientRequest.get(
              `${mergeRequestPath(projectId, mergeRequestIid)}/discussions`,
            ).pipe(
              HttpClientRequest.setUrlParams({ per_page: '100', page: String(page) }),
              HttpClientRequest.bearerToken(token),
              http.execute,
              Effect.orDie,
            );

            if (response.status === 401 || response.status === 403) {
              return yield* new InvalidToken({ message: 'GitLab rejected the token' });
            }
            if (response.status !== 200) {
              return yield* Effect.die(
                new Error(`GitLab /discussions unexpected status ${response.status}`),
              );
            }

            const items = yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(DiscussionResponseSchema),
            )(response).pipe(Effect.orDie);

            return { items, response };
          }),
        );

        return discussions.map(discussion => ({
          id: discussion.id,
          notes: discussion.notes.map(note => ({
            id: note.id,
            body: note.body,
            authorUsername: note.author.username,
            isSystem: note.system,
          })),
        }));
      });

      const reply = Effect.fn('GitLabDiscussions.reply')(function* ({
        token,
        projectId,
        mergeRequestIid,
        discussionId,
        body,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly discussionId: string;
        readonly body: string;
      }) {
        const response = yield* HttpClientRequest.post(
          `${mergeRequestPath(projectId, mergeRequestIid)}/discussions/${encodeURIComponent(discussionId)}/notes`,
        ).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status !== 201) {
          return yield* Effect.die(
            new Error(`GitLab /discussions/notes unexpected status ${response.status}`),
          );
        }

        const note = yield* HttpClientResponse.schemaBodyJson(NoteResponseSchema)(response).pipe(
          Effect.orDie,
        );
        return { noteId: note.id };
      });

      return GitLabDiscussions.of({ list, reply });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
