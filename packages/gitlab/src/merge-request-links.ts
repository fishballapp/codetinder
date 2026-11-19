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
import { GitLabFiles } from './files';
import { gitLabInteractiveClient, paginateGitLab } from './gitlab';
import { InvalidToken } from './users';

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The old-file line GitLab pairs with `newLine` in a unified diff's hunks, or undefined when the
 * new line is outside every hunk.
 */
export const oldLineAt = (diff: string, newLine: number): number | undefined => {
  let oldCursor = 0;
  let newCursor = 0;
  // Lines without a diff prefix (the empty element after a trailing newline, the `\` marker)
  // advance neither line.
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldCursor = Number(header[1]);
      newCursor = Number(header[2]);
    } else if (line.startsWith('-')) {
      // A removed line has no new line, so it never matches.
      oldCursor += 1;
    } else if (line.startsWith('+') || line.startsWith(' ')) {
      if (newCursor === newLine) return oldCursor;
      newCursor += 1;
      if (line.startsWith(' ')) oldCursor += 1;
    }
  }
  return undefined;
};

/** GitLab's diff line anchor: the SHA-1 of the file path, then the old and new line. */
export const lineCode = (pathSha1: string, oldLine: number, newLine: number): string =>
  `${pathSha1}_${oldLine}_${newLine}`;

const sha1Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

/** The 1-based lines on which `text` first appears in `fileText`, or undefined when it doesn't. */
const lineSpan = (fileText: string, text: string): { start: number; end: number } | undefined => {
  const index = fileText.indexOf(text);
  if (index === -1) return undefined;
  // Splitting the text before the match gives one piece per newline plus one: the match's line.
  const start = fileText.slice(0, index).split('\n').length;
  return { start, end: start + text.trimEnd().split('\n').length - 1 };
};

const ProjectResponseSchema = Schema.Struct({
  name: Schema.String,
  web_url: Schema.String,
});

const MergeRequestResponseSchema = Schema.Struct({
  web_url: Schema.String,
  diff_refs: Schema.Struct({ head_sha: Schema.String }),
});

const DiffsResponseSchema = Schema.Array(
  Schema.Struct({
    new_path: Schema.String,
    diff: Schema.String,
  }),
);

/** A piece of a file: its path in the repo, and its text verbatim. */
type FileSnippet = { readonly file: string; readonly text: string };

export type MergeRequestLinks = {
  readonly projectName: string;
  readonly mergeRequestUrl: string;
  readonly functionUrl: string;
  /** Each context symbol's definition: its file at the MR's head, on the lines it spans. */
  readonly definitionUrls: ReadonlyMap<string, string>;
};

type RoundLinksArgs = {
  readonly token: Redacted.Redacted<string>;
  readonly projectId: string;
  readonly mergeRequestIid: number;
  readonly target: FileSnippet;
  readonly context: readonly (FileSnippet & { readonly symbol: string })[];
};

export class GitLabMergeRequestLinks extends Context.Service<
  GitLabMergeRequestLinks,
  {
    /**
     * Where the merge request is, the URL of its Changes tab scrolled to the first line of the
     * target's text, and where each context definition is at the MR's head.
     */
    readonly forRound: (args: RoundLinksArgs) => Effect.Effect<MergeRequestLinks, InvalidToken>;
  }
>()('@codetinder/gitlab/GitLabMergeRequestLinks') {
  static readonly layer = Layer.effect(
    GitLabMergeRequestLinks,
    Effect.gen(function* () {
      const gitLabFiles = yield* GitLabFiles;
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const projectPath = (projectId: string) =>
        `/api/v4/projects/${encodeURIComponent(projectId)}`;

      const getProject = Effect.fn('GitLabMergeRequestLinks.getProject')(function* ({
        token,
        projectId,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
      }) {
        const response = yield* HttpClientRequest.get(projectPath(projectId)).pipe(
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /projects/:id unexpected status ${response.status}`),
          );
        }

        const project = yield* HttpClientResponse.schemaBodyJson(ProjectResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return { name: project.name, webUrl: project.web_url };
      });

      const getMergeRequest = Effect.fn('GitLabMergeRequestLinks.getMergeRequest')(function* ({
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

        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /merge_requests/:iid unexpected status ${response.status}`),
          );
        }

        const mergeRequest = yield* HttpClientResponse.schemaBodyJson(MergeRequestResponseSchema)(
          response,
        ).pipe(Effect.orDie);
        return { webUrl: mergeRequest.web_url, headSha: mergeRequest.diff_refs.head_sha };
      });

      const listDiffs = Effect.fn('GitLabMergeRequestLinks.listDiffs')(function* ({
        token,
        projectId,
        mergeRequestIid,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly mergeRequestIid: number;
      }) {
        return yield* paginateGitLab(page =>
          Effect.gen(function* () {
            const response = yield* HttpClientRequest.get(
              `${projectPath(projectId)}/merge_requests/${mergeRequestIid}/diffs`,
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
                new Error(`GitLab /merge_requests/:iid/diffs unexpected status ${response.status}`),
              );
            }

            const items = yield* HttpClientResponse.schemaBodyJson(DiffsResponseSchema)(
              response,
            ).pipe(Effect.orDie);

            return { items, response };
          }),
        );
      });

      const forRound = Effect.fn('GitLabMergeRequestLinks.forRound')(function* ({
        token,
        projectId,
        mergeRequestIid,
        target,
        context,
      }: RoundLinksArgs) {
        const { project, mergeRequest, diffs } = yield* Effect.all(
          {
            project: getProject({ token, projectId }),
            mergeRequest: getMergeRequest({ token, projectId, mergeRequestIid }),
            diffs: listDiffs({ token, projectId, mergeRequestIid }),
          },
          { concurrency: 'unbounded' },
        );

        // Each file once, at the head: the target's and every definition's.
        // ponytail: one file's unexpected status (a 429, a 5xx) loses all the round's links, the bar's
        // included, until a reload. Rare and recoverable, so a file isn't fetched on its own terms.
        const files = new Map(
          yield* Effect.forEach(
            new Set([target.file, ...context.map(snippet => snippet.file)]),
            file =>
              gitLabFiles
                .readText({ token, projectId, path: file, ref: mergeRequest.headSha })
                .pipe(
                  // A file that isn't UTF-8 has no line to link, like one that's gone.
                  Effect.catchTag('FileNotUtf8', () => Effect.succeed(Option.none<string>())),
                  Effect.map(text => [file, Option.getOrUndefined(text)] as const),
                ),
            { concurrency: 'unbounded' },
          ),
        );

        const fileSha = yield* Effect.promise(() => sha1Hex(target.file));
        const diff = diffs.find(entry => entry.new_path === target.file);
        const targetText = files.get(target.file);
        const targetLine =
          targetText === undefined ? undefined : lineSpan(targetText, target.text)?.start;
        // The anchor is the file's, or the function's line when GitLab's diff pairs it with an old one.
        const anchor = (() => {
          if (diff === undefined) return undefined;
          if (targetLine === undefined) return fileSha;
          const oldLine = oldLineAt(diff.diff, targetLine);
          return oldLine === undefined ? fileSha : lineCode(fileSha, oldLine, targetLine);
        })();

        const blobUrl = (file: string) =>
          `${project.webUrl}/-/blob/${mergeRequest.headSha}/${file.split('/').map(encodeURIComponent).join('/')}`;
        const definitionUrl = (snippet: FileSnippet) => {
          const fileText = files.get(snippet.file);
          const span = fileText === undefined ? undefined : lineSpan(fileText, snippet.text);
          if (span === undefined) return blobUrl(snippet.file);
          if (span.start === span.end) return `${blobUrl(snippet.file)}#L${span.start}`;
          return `${blobUrl(snippet.file)}#L${span.start}-${span.end}`;
        };

        return {
          projectName: project.name,
          mergeRequestUrl: mergeRequest.webUrl,
          functionUrl:
            anchor === undefined
              ? `${mergeRequest.webUrl}/diffs`
              : `${mergeRequest.webUrl}/diffs#${anchor}`,
          definitionUrls: new Map(
            context.map(snippet => [snippet.symbol, definitionUrl(snippet)] as const),
          ),
        };
      });

      return GitLabMergeRequestLinks.of({ forRound });
    }),
  ).pipe(Layer.provide(Layer.mergeAll(GitLabFiles.layer, FetchHttpClient.layer)));
}
