import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import type * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { gitLabInteractiveClient, repeatable } from './gitlab';
import { isSweepGoal } from './sweep-trigger';

/** GitLab wouldn't start the pipeline (the project's CI doesn't allow one, say): its reason. */
export class PipelineRefused extends Schema.TaggedError<PipelineRefused>()('PipelineRefused', {
  message: Schema.String,
}) {}

/** One file of a comparison: the lines it adds, and whether GitLab withheld its diff. */
export type ComparedFile = {
  readonly path: string;
  readonly addedLines: number;
  /** Its diff was too large to send, so `addedLines` counts none of it. */
  readonly isTruncated: boolean;
};

const CompareResponseSchema = Schema.Struct({
  compare_timeout: Schema.optional(Schema.NullOr(Schema.Boolean)),
  diffs: Schema.Array(
    Schema.Struct({
      new_path: Schema.String,
      diff: Schema.String,
      collapsed: Schema.optional(Schema.NullOr(Schema.Boolean)),
      too_large: Schema.optional(Schema.NullOr(Schema.Boolean)),
    }),
  ),
});

const MergeRequestResponseSchema = Schema.Struct({
  web_url: Schema.String,
  state: Schema.String,
});

// GitLab's refusal is a string, or a field's messages (`{"base": ["…"]}`).
const RefusalResponseSchema = Schema.Struct({
  message: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Array(Schema.String))]),
});

// Active only: a sweep's session runs for as long as it holds the sweep.
const ACTIVE_SESSIONS_QUERY = `query ($fullPath: ID!) {
  project(fullPath: $fullPath) {
    duoWorkflowWorkflows(statuses: [CREATED, RUNNING], first: 100) { nodes { goal webUrl } }
  }
}`;

const ActiveSessionsResponseSchema = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            duoWorkflowWorkflows: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({ goal: Schema.NullOr(Schema.String), webUrl: Schema.String }),
              ),
            }),
          }),
        ),
      }),
    ),
  ),
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

const projectPath = (projectId: string) => `/api/v4/projects/${encodeURIComponent(projectId)}`;

/** A diff's added lines. GitLab's diffs carry no file headers, so every `+` line is one. */
const addedLineCount = (diff: string): number =>
  diff.split('\n').filter(line => line.startsWith('+')).length;

/** What the project page's sweep reads and starts on GitLab, as the developer. */
export class GitLabSweepPage extends Context.Service<
  GitLabSweepPage,
  {
    /** Starts a pipeline on `ref` as the token's user: the pipeline Sweep now's trigger hears. */
    readonly startPipeline: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly ref: string;
    }) => Effect.Effect<void, PipelineRefused>;

    /**
     * The files changed from `from` to `to` (from their merge base), with their added lines.
     * `isTruncated` when GitLab stopped comparing before the end, so files may be missing.
     */
    readonly compare: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<{ readonly files: readonly ComparedFile[]; readonly isTruncated: boolean }>;

    /** An MR's page and whether it is still open; none when it is gone. */
    readonly mergeRequest: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly mergeRequestIid: number;
    }) => Effect.Effect<Option.Option<{ readonly url: string; readonly isOpen: boolean }>>;

    /** The page of the session sweeping the project now, or about to; none while there is none. */
    readonly sweepSession: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectFullPath: string;
      readonly defaultBranch: string;
    }) => Effect.Effect<Option.Option<string>>;
  }
>()('@codetinder/gitlab/GitLabSweepPage') {
  static readonly layer = Layer.effect(
    GitLabSweepPage,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const startPipeline = Effect.fn('GitLabSweepPage.startPipeline')(function* ({
        token,
        projectId,
        ref,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly ref: string;
      }) {
        const response = yield* HttpClientRequest.post(`${projectPath(projectId)}/pipeline`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({ ref }),
          http.execute,
          Effect.orDie,
        );
        if (response.status === 201) return;
        if (response.status >= 500) {
          return yield* Effect.die(
            new Error(`GitLab /projects/:id/pipeline unexpected status ${response.status}`),
          );
        }
        const refusal = yield* HttpClientResponse.schemaBodyJson(RefusalResponseSchema)(
          response,
        ).pipe(Effect.option);
        const message = Option.match(refusal, {
          onNone: () => `GitLab answered ${response.status}`,
          onSome: ({ message }) =>
            typeof message === 'string' ? message : Object.values(message).flat().join(' '),
        });
        return yield* new PipelineRefused({ message });
      });

      const compare = Effect.fn('GitLabSweepPage.compare')(function* ({
        token,
        projectId,
        from,
        to,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly from: string;
        readonly to: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `${projectPath(projectId)}/repository/compare`,
        ).pipe(
          HttpClientRequest.setUrlParams({ from, to }),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /repository/compare unexpected status ${response.status}`),
          );
        }
        const body = yield* HttpClientResponse.schemaBodyJson(CompareResponseSchema)(response).pipe(
          Effect.orDie,
        );
        return {
          files: body.diffs.map(file => ({
            path: file.new_path,
            addedLines: addedLineCount(file.diff),
            isTruncated: file.too_large === true || file.collapsed === true,
          })),
          isTruncated: body.compare_timeout === true,
        };
      });

      const mergeRequest = Effect.fn('GitLabSweepPage.mergeRequest')(function* ({
        token,
        projectId,
        mergeRequestIid,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly mergeRequestIid: number;
      }) {
        const response = yield* HttpClientRequest.get(
          `${projectPath(projectId)}/merge_requests/${mergeRequestIid}`,
        ).pipe(HttpClientRequest.bearerToken(token), http.execute, Effect.orDie);
        if (response.status === 404) return Option.none();
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /merge_requests/:iid unexpected status ${response.status}`),
          );
        }
        const body = yield* HttpClientResponse.schemaBodyJson(MergeRequestResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return Option.some({ url: body.web_url, isOpen: body.state === 'opened' });
      });

      const sweepSession = Effect.fn('GitLabSweepPage.sweepSession')(function* ({
        token,
        projectFullPath,
        defaultBranch,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectFullPath: string;
        readonly defaultBranch: string;
      }) {
        const response = yield* HttpClientRequest.post('/api/graphql').pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.bodyJsonUnsafe({
            query: ACTIVE_SESSIONS_QUERY,
            variables: { fullPath: projectFullPath },
          }),
          http.execute,
          Effect.orDie,
          repeatable,
        );
        if (response.status !== 200) {
          const unexpectedStatus = `GitLab /api/graphql unexpected status ${response.status}`;
          return yield* Effect.die(new Error(unexpectedStatus));
        }
        const { data, errors } = yield* HttpClientResponse.schemaBodyJson(
          ActiveSessionsResponseSchema,
        )(response).pipe(Effect.orDie);
        if (errors !== undefined && errors.length > 0) {
          const graphqlErrors = errors.map(({ message }) => message).join('; ');
          return yield* Effect.die(new Error(graphqlErrors));
        }
        const sessions = data?.project?.duoWorkflowWorkflows.nodes ?? [];
        // Newest first. The oldest holds the sweep: a run that starts while one sweeps is turned
        // away within a minute.
        const sweeping = sessions.findLast(
          ({ goal }) => goal !== null && isSweepGoal({ goal, defaultBranch }),
        );
        return Option.fromNullishOr(sweeping?.webUrl);
      });

      return GitLabSweepPage.of({ startPipeline, compare, mergeRequest, sweepSession });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
