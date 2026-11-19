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
import { GITLAB_BASE_URL, gitLabInteractiveClient } from './gitlab';
import { InvalidToken } from './users';

/** The file exists, but isn't UTF-8 text: read as text, it would come back altered. */
export class FileNotUtf8 extends Schema.TaggedError<FileNotUtf8>()('FileNotUtf8', {
  path: Schema.String,
}) {}

/** `bytes` as UTF-8 text, a byte order mark kept; none when they aren't valid UTF-8. */
const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const FileResponseSchema = Schema.Struct({
  content: Schema.String,
  encoding: Schema.Literal('base64'),
  last_commit_id: Schema.String,
});

const encodeSegments = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Where a file is on GitLab's web UI, at `ref`. */
export const fileUrl = ({
  projectFullPath,
  ref,
  path,
}: {
  readonly projectFullPath: string;
  readonly ref: string;
  readonly path: string;
}) => `${GITLAB_BASE_URL}/${projectFullPath}/-/blob/${encodeSegments(ref)}/${encodeSegments(path)}`;

export class GitLabFiles extends Context.Service<
  GitLabFiles,
  {
    /**
     * The file's text at `ref`, exactly as stored; none when the file doesn't exist there, and
     * `FileNotUtf8` when it isn't UTF-8 text.
     */
    readonly readText: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly path: string;
      readonly ref: string;
    }) => Effect.Effect<Option.Option<string>, InvalidToken | FileNotUtf8>;
    /**
     * As `readText`, with the commit that last changed the file at `ref`: committing an update
     * that names it fails if the file has changed since, instead of overwriting the change.
     */
    readonly readRevision: (args: {
      readonly token: Redacted.Redacted<string>;
      readonly projectId: string;
      readonly path: string;
      readonly ref: string;
    }) => Effect.Effect<
      Option.Option<{ readonly text: string; readonly lastCommitId: string }>,
      InvalidToken | FileNotUtf8
    >;
  }
>()('@codetinder/gitlab/GitLabFiles') {
  static readonly layer = Layer.effect(
    GitLabFiles,
    Effect.gen(function* () {
      const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);

      const readText = Effect.fn('GitLabFiles.readText')(function* ({
        token,
        projectId,
        path,
        ref,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly path: string;
        readonly ref: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}/raw`,
        ).pipe(
          HttpClientRequest.setUrlParam('ref', ref),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status === 404) return Option.none();
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /repository/files/:path/raw unexpected status ${response.status}`),
          );
        }

        const bytes = new Uint8Array(yield* response.arrayBuffer.pipe(Effect.orDie));
        const text = decodeUtf8(bytes);
        if (text === undefined) return yield* new FileNotUtf8({ path });
        return Option.some(text);
      });

      const readRevision = Effect.fn('GitLabFiles.readRevision')(function* ({
        token,
        projectId,
        path,
        ref,
      }: {
        readonly token: Redacted.Redacted<string>;
        readonly projectId: string;
        readonly path: string;
        readonly ref: string;
      }) {
        const response = yield* HttpClientRequest.get(
          `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(path)}`,
        ).pipe(
          HttpClientRequest.setUrlParam('ref', ref),
          HttpClientRequest.bearerToken(token),
          http.execute,
          Effect.orDie,
        );

        if (response.status === 401 || response.status === 403) {
          return yield* new InvalidToken({ message: 'GitLab rejected the token' });
        }
        if (response.status === 404) return Option.none();
        if (response.status !== 200) {
          return yield* Effect.die(
            new Error(`GitLab /repository/files/:path unexpected status ${response.status}`),
          );
        }

        const file = yield* HttpClientResponse.schemaBodyJson(FileResponseSchema)(response).pipe(
          Effect.orDie,
        );
        const text = decodeUtf8(Uint8Array.from(atob(file.content), char => char.charCodeAt(0)));
        if (text === undefined) return yield* new FileNotUtf8({ path });
        return Option.some({ text, lastCommitId: file.last_commit_id });
      });

      return GitLabFiles.of({ readText, readRevision });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
