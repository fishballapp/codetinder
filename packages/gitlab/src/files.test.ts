import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import { FileNotUtf8, fileUrl, GitLabFiles } from './files';
import { InvalidToken } from './users';

/** A GitLab answering every raw-file request with `status`, `body` on a 200; requests land in `seen`. */
const withGitLab = (
  status: number,
  body: string | Uint8Array<ArrayBuffer> = '',
  seen: URL[] = [],
) =>
  Layer.mergeAll(
    GitLabFiles.layer,
    Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(new URL(request.url));
      return new Response(status === 200 ? body : 'nope', { status });
    }),
  );

const read = Effect.gen(function* () {
  return yield* (yield* GitLabFiles).readText({
    token: Redacted.make('oauth-token'),
    projectId: '42',
    path: '.codetinder/principles.md',
    ref: 'main',
  });
});

describe('GitLabFiles.readText', () => {
  it.effect('reads the raw file at the ref', () => {
    const seen: URL[] = [];
    return Effect.gen(function* () {
      expect(yield* read).toEqual(Option.some('# Coding principles\n'));
      expect(seen.map(url => `${url.pathname}?${url.searchParams}`)).toEqual([
        '/api/v4/projects/42/repository/files/.codetinder%2Fprinciples.md/raw?ref=main',
      ]);
    }).pipe(Effect.provide(withGitLab(200, '# Coding principles\n', seen)));
  });

  it.effect('keeps a byte order mark, so a file is read back exactly', () =>
    Effect.gen(function* () {
      expect(yield* read).toEqual(Option.some('\uFEFF# Agents\n'));
    }).pipe(
      Effect.provide(
        withGitLab(
          200,
          new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('# Agents\n')]),
        ),
      ),
    ),
  );

  it.effect(
    'fails with FileNotUtf8 for a file that is not UTF-8, rather than read it garbled',
    () =>
      Effect.gen(function* () {
        expect(yield* Effect.flip(read)).toEqual(
          new FileNotUtf8({ path: '.codetinder/principles.md' }),
        );
      }).pipe(Effect.provide(withGitLab(200, new Uint8Array([0x63, 0x61, 0x66, 0xe9])))),
  );

  it.effect('answers none for a file not on the ref', () =>
    Effect.gen(function* () {
      expect(yield* read).toEqual(Option.none());
    }).pipe(Effect.provide(withGitLab(404))),
  );

  it.effect('fails with InvalidToken when GitLab refuses the token', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(read)).toBeInstanceOf(InvalidToken);
    }).pipe(Effect.provide(withGitLab(401))),
  );
});

describe('GitLabFiles.readRevision', () => {
  const readRevision = Effect.gen(function* () {
    return yield* (yield* GitLabFiles).readRevision({
      token: Redacted.make('oauth-token'),
      projectId: '42',
      path: '.gitlab/duo/agent-config.yml',
      ref: 'codetinder/sandbox-fix-a',
    });
  });
  const answering = (body: object) =>
    Layer.mergeAll(
      GitLabFiles.layer,
      Layer.succeed(FetchHttpClient.Fetch, async input => {
        const request = input instanceof Request ? input : new Request(input);
        expect(new URL(request.url).pathname).toBe(
          '/api/v4/projects/42/repository/files/.gitlab%2Fduo%2Fagent-config.yml',
        );
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

  it.effect('reads the text and the commit that last changed it', () =>
    Effect.gen(function* () {
      expect(yield* readRevision).toEqual(
        Option.some({ text: 'image: node:24\n', lastCommitId: 'c0ffee' }),
      );
    }).pipe(
      Effect.provide(
        answering({
          content: btoa('image: node:24\n'),
          encoding: 'base64',
          last_commit_id: 'c0ffee',
        }),
      ),
    ),
  );

  it.effect('fails with FileNotUtf8 for a file that is not UTF-8', () =>
    Effect.gen(function* () {
      expect(yield* Effect.flip(readRevision)).toBeInstanceOf(FileNotUtf8);
    }).pipe(
      Effect.provide(
        answering({ content: btoa('caf\xe9'), encoding: 'base64', last_commit_id: 'c' }),
      ),
    ),
  );
});

describe('fileUrl', () => {
  it('links the file on the ref, each segment encoded', () => {
    expect(
      fileUrl({ projectFullPath: 'g/p', ref: 'main', path: '.codetinder/my principles.md' }),
    ).toBe('https://gitlab.com/g/p/-/blob/main/.codetinder/my%20principles.md');
  });
});
