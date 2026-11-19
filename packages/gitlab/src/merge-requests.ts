import * as Config from 'effect/Config';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import {
  checkStatus,
  GITLAB_BASE_URL,
  type GitLabRequestFailed,
  gitLabClient,
  paginateGitLab,
} from './gitlab';

export type GitLabMergeRequest = {
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly webUrl: string;
  readonly isDraft: boolean;
  /** Neither merged nor closed. */
  readonly isOpen: boolean;
  /** Null once the source project is deleted. */
  readonly sourceProjectId: number | null;
  readonly targetProjectId: number;
};

export type GitLabCreatedMergeRequest = {
  readonly iid: number;
  readonly webUrl: string;
};

/** A merge request as a search lists it. */
export type GitLabListedMergeRequest = {
  readonly iid: number;
  readonly webUrl: string;
  readonly description: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
};

const ListedMergeRequestResponseSchema = Schema.Struct({
  iid: Schema.Int,
  web_url: Schema.String,
  description: Schema.NullOr(Schema.String),
  source_branch: Schema.String,
  target_branch: Schema.String,
  source_project_id: Schema.NullOr(Schema.Int),
});

export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()('NoteNotFound', {
  noteId: Schema.Int,
  message: Schema.String,
}) {}

const mergeRequestPath = (projectId: string, mergeRequestIid: number) =>
  `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests/${mergeRequestIid}`;

const MergeRequestResponseSchema = Schema.Struct({
  source_branch: Schema.String,
  target_branch: Schema.String,
  web_url: Schema.String,
  draft: Schema.Boolean,
  state: Schema.String,
  source_project_id: Schema.NullOr(Schema.Int),
  target_project_id: Schema.Int,
});

const CreatedMergeRequestResponseSchema = Schema.Struct({
  iid: Schema.Int,
  web_url: Schema.String,
});

const CreatedNoteResponseSchema = Schema.Struct({
  author: Schema.Struct({ username: Schema.String }),
});

const ReviewersResponseSchema = Schema.Array(
  Schema.Struct({ user: Schema.Struct({ username: Schema.String }), state: Schema.String }),
);

const SystemNotesResponseSchema = Schema.Array(
  Schema.Struct({ id: Schema.Int, system: Schema.Boolean, body: Schema.String }),
);

/** Whom a system note requests a review from: GitLab's "requested review from @a and @b". */
const REVIEW_REQUEST = /^requested review from (.*?)(?: and removed review request for .*)?$/;

const isReviewRequestFor = (body: string, reviewer: string): boolean => {
  const requested = REVIEW_REQUEST.exec(body)?.[1] ?? '';
  return requested.split(/[\s,]+/).includes(`@${reviewer}`);
};

const DiscussionResponseSchema = Schema.Struct({
  id: Schema.String,
  notes: Schema.Array(Schema.Struct({ id: Schema.Int })),
});

export class GitLabMergeRequests extends Context.Service<
  GitLabMergeRequests,
  {
    readonly get: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
    }) => Effect.Effect<GitLabMergeRequest, GitLabRequestFailed>;
    readonly createMergeRequest: (args: {
      readonly projectId: string;
      readonly sourceBranch: string;
      readonly targetBranch: string;
      readonly title: string;
      readonly description: string;
    }) => Effect.Effect<GitLabCreatedMergeRequest, GitLabRequestFailed>;
    /**
     * The project's own merge requests in `state` whose title or description has `search`, newest
     * first; a fork's MR isn't one.
     */
    readonly list: (args: {
      readonly projectId: string;
      readonly state: 'opened' | 'closed';
      readonly search: string;
    }) => Effect.Effect<readonly GitLabListedMergeRequest[], GitLabRequestFailed>;
    readonly updateDescription: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly description: string;
    }) => Effect.Effect<void, GitLabRequestFailed>;
    /** Answers who the note is by: in a flow, its service account. */
    readonly createNote: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly body: string;
    }) => Effect.Effect<{ readonly authorUsername: string }, GitLabRequestFailed>;
    /**
     * Marks `reviewer`'s review of the merge request done (`reviewed`), when it is one of the MR's
     * reviewers and hasn't reviewed yet. Answers whether it did.
     */
    readonly finishReview: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly reviewer: string;
    }) => Effect.Effect<boolean, GitLabRequestFailed>;
    /**
     * The system note of the latest request for `reviewer`'s review (adding them, or "re-request
     * review"), among the MR's newest 100 notes: every session one request starts reads the same.
     */
    readonly latestReviewRequest: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly reviewer: string;
    }) => Effect.Effect<Option.Option<number>, GitLabRequestFailed>;
    /** Replies in the discussion that holds the note, so the reply lands in that thread. */
    readonly replyToNote: (args: {
      readonly projectId: string;
      readonly mergeRequestIid: number;
      readonly noteId: number;
      readonly body: string;
    }) => Effect.Effect<void, GitLabRequestFailed | NoteNotFound>;
  }
>()('@codetinder/gitlab/GitLabMergeRequests') {
  static readonly layer = Layer.effect(
    GitLabMergeRequests,
    Effect.gen(function* () {
      const baseUrl = yield* Config.String('GITLAB_BASE_URL').pipe(
        Config.withDefault(GITLAB_BASE_URL),
      );
      const token = yield* Config.Redacted('GITLAB_TOKEN');

      const http = gitLabClient(yield* HttpClient.HttpClient, baseUrl, token);

      const get = Effect.fn('GitLabMergeRequests.get')(function* ({
        projectId,
        mergeRequestIid,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
      }) {
        const path = mergeRequestPath(projectId, mergeRequestIid);
        const response = yield* HttpClientRequest.get(path).pipe(http.execute, Effect.orDie);

        yield* checkStatus(response, 'GET', path);

        const body = yield* HttpClientResponse.schemaBodyJson(MergeRequestResponseSchema)(
          response,
        ).pipe(Effect.orDie);

        return {
          sourceBranch: body.source_branch,
          targetBranch: body.target_branch,
          webUrl: body.web_url,
          isDraft: body.draft,
          isOpen: body.state === 'opened',
          sourceProjectId: body.source_project_id,
          targetProjectId: body.target_project_id,
        };
      });

      const createMergeRequest = Effect.fn('GitLabMergeRequests.createMergeRequest')(function* ({
        projectId,
        sourceBranch,
        targetBranch,
        title,
        description,
      }: {
        readonly projectId: string;
        readonly sourceBranch: string;
        readonly targetBranch: string;
        readonly title: string;
        readonly description: string;
      }) {
        const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`;
        const response = yield* HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            source_branch: sourceBranch,
            target_branch: targetBranch,
            title,
            description,
            remove_source_branch: true,
            squash: false,
          }),
          http.execute,
          Effect.orDie,
        );

        yield* checkStatus(response, 'POST', path);

        const created = yield* HttpClientResponse.schemaBodyJson(CreatedMergeRequestResponseSchema)(
          response,
        ).pipe(Effect.orDie);

        return { iid: created.iid, webUrl: created.web_url };
      });

      const list = Effect.fn('GitLabMergeRequests.list')(function* ({
        projectId,
        state,
        search,
      }: {
        readonly projectId: string;
        readonly state: 'opened' | 'closed';
        readonly search: string;
      }) {
        const path = `/api/v4/projects/${encodeURIComponent(projectId)}/merge_requests`;
        const mergeRequests = yield* paginateGitLab(page =>
          Effect.gen(function* () {
            const response = yield* HttpClientRequest.get(path).pipe(
              HttpClientRequest.setUrlParams({
                search,
                state,
                per_page: '100',
                page: String(page),
              }),
              http.execute,
              Effect.orDie,
            );
            yield* checkStatus(response, 'GET', path);
            const items = yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(ListedMergeRequestResponseSchema),
            )(response).pipe(Effect.orDie);
            return { items, response };
          }),
        );
        return mergeRequests
          .filter(mergeRequest => mergeRequest.source_project_id === Number(projectId))
          .map(mergeRequest => ({
            iid: mergeRequest.iid,
            webUrl: mergeRequest.web_url,
            description: mergeRequest.description ?? '',
            sourceBranch: mergeRequest.source_branch,
            targetBranch: mergeRequest.target_branch,
          }));
      });

      const updateDescription = Effect.fn('GitLabMergeRequests.updateDescription')(function* ({
        projectId,
        mergeRequestIid,
        description,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly description: string;
      }) {
        const path = mergeRequestPath(projectId, mergeRequestIid);
        const response = yield* HttpClientRequest.put(path).pipe(
          HttpClientRequest.bodyJsonUnsafe({ description }),
          http.execute,
          Effect.orDie,
        );
        yield* checkStatus(response, 'PUT', path);
      });

      const createNote = Effect.fn('GitLabMergeRequests.createNote')(function* ({
        projectId,
        mergeRequestIid,
        body,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly body: string;
      }) {
        const path = `${mergeRequestPath(projectId, mergeRequestIid)}/notes`;
        const response = yield* HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
          http.execute,
          Effect.orDie,
        );

        yield* checkStatus(response, 'POST', path);
        const note = yield* HttpClientResponse.schemaBodyJson(CreatedNoteResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return { authorUsername: note.author.username };
      });

      // Publishing no draft notes with a `reviewer_state` is how a review is finished from the
      // API: GitLab has no route that sets a reviewer's state alone.
      const finishReview = Effect.fn('GitLabMergeRequests.finishReview')(function* ({
        projectId,
        mergeRequestIid,
        reviewer,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly reviewer: string;
      }) {
        const reviewersPath = `${mergeRequestPath(projectId, mergeRequestIid)}/reviewers`;
        const response = yield* HttpClientRequest.get(reviewersPath).pipe(
          http.execute,
          Effect.orDie,
        );
        yield* checkStatus(response, 'GET', reviewersPath);
        const reviewers = yield* HttpClientResponse.schemaBodyJson(ReviewersResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        const isAwaited = reviewers.some(
          ({ user, state }) => user.username === reviewer && state === 'unreviewed',
        );
        if (!isAwaited) return false;

        const publishPath = `${mergeRequestPath(projectId, mergeRequestIid)}/draft_notes/bulk_publish`;
        const published = yield* HttpClientRequest.post(publishPath).pipe(
          HttpClientRequest.bodyJsonUnsafe({ reviewer_state: 'reviewed' }),
          http.execute,
          Effect.orDie,
        );
        yield* checkStatus(published, 'POST', publishPath);
        return true;
      });

      // ponytail: one page, newest first. A request followed by 100 other notes before its run
      // reads them is taken as none, so the run doesn't replace the commit's round.
      const latestReviewRequest = Effect.fn('GitLabMergeRequests.latestReviewRequest')(function* ({
        projectId,
        mergeRequestIid,
        reviewer,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly reviewer: string;
      }) {
        const path = `${mergeRequestPath(projectId, mergeRequestIid)}/notes`;
        const response = yield* HttpClientRequest.get(path).pipe(
          HttpClientRequest.setUrlParams({ sort: 'desc', order_by: 'created_at', per_page: '100' }),
          http.execute,
          Effect.orDie,
        );
        yield* checkStatus(response, 'GET', path);
        const notes = yield* HttpClientResponse.schemaBodyJson(SystemNotesResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        const request = notes.find(
          ({ system, body }) => system && isReviewRequestFor(body, reviewer),
        );
        return Option.fromNullishOr(request?.id);
      });

      const listDiscussions = Effect.fn('GitLabMergeRequests.listDiscussions')(function* ({
        projectId,
        mergeRequestIid,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
      }) {
        const path = `${mergeRequestPath(projectId, mergeRequestIid)}/discussions`;
        return yield* paginateGitLab(page =>
          Effect.gen(function* () {
            const response = yield* HttpClientRequest.get(path).pipe(
              HttpClientRequest.setUrlParams({ per_page: '100', page: String(page) }),
              http.execute,
              Effect.orDie,
            );

            yield* checkStatus(response, 'GET', path);

            const items = yield* HttpClientResponse.schemaBodyJson(
              Schema.Array(DiscussionResponseSchema),
            )(response).pipe(Effect.orDie);

            return { items, response };
          }),
        );
      });

      const replyToNote = Effect.fn('GitLabMergeRequests.replyToNote')(function* ({
        projectId,
        mergeRequestIid,
        noteId,
        body,
      }: {
        readonly projectId: string;
        readonly mergeRequestIid: number;
        readonly noteId: number;
        readonly body: string;
      }) {
        const discussions = yield* listDiscussions({ projectId, mergeRequestIid });
        const discussion = discussions.find(candidate =>
          candidate.notes.some(note => note.id === noteId),
        );
        if (discussion === undefined) {
          return yield* new NoteNotFound({
            noteId,
            message: `note ${noteId} is in no discussion of merge request !${mergeRequestIid}`,
          });
        }

        const path = `${mergeRequestPath(projectId, mergeRequestIid)}/discussions/${encodeURIComponent(discussion.id)}/notes`;
        const response = yield* HttpClientRequest.post(path).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body }),
          http.execute,
          Effect.orDie,
        );

        yield* checkStatus(response, 'POST', path);
      });

      return GitLabMergeRequests.of({
        get,
        createMergeRequest,
        list,
        updateDescription,
        createNote,
        finishReview,
        latestReviewRequest,
        replyToNote,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
