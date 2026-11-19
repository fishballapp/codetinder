import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { GitLabMergeRequestLinks, lineCode, oldLineAt } from './merge-request-links';
import { InvalidToken } from './users';

const scriptedFetch = (
  handler: (request: Request) => Response | Promise<Response>,
): typeof globalThis.fetch => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handler(request);
  };
  return fetch;
};

const withLinks = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(GitLabMergeRequestLinks.layer, Layer.succeed(FetchHttpClient.Fetch, fetch));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** SHA-1 of 'src/demo.ts', GitLab's anchor prefix for that file. */
const DEMO_SHA = '62dc98a671da1e1a8ad3c723a02775e7d94b2dd7';
const PROJECT_URL = 'https://gitlab.com/group/demo';
const WEB_URL = `${PROJECT_URL}/-/merge_requests/7`;

const DEMO_DIFF = [
  '@@ -1,2 +1,5 @@',
  ' const x = 1;',
  '-const y = 2;',
  '+const y = 3;',
  '+function add(a, b) {',
  '+  return a + b;',
  '+}',
].join('\n');

/**
 * A GitLab in which the demo MR changes `src/demo.ts`. `files` are the repo's files at the head,
 * by path; a path not in it is a 404. `requested` collects each file request's path.
 */
const fakeGitLab = (options: {
  readonly projectId?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly diffs?: readonly { readonly new_path: string; readonly diff: string }[];
  readonly requested?: string[];
}) => {
  const project = `/api/v4/projects/${encodeURIComponent(options.projectId ?? '42')}`;
  const rawFiles = new Map(
    Object.entries(options.files ?? {}).map(([path, text]) => [
      `${project}/repository/files/${encodeURIComponent(path)}/raw`,
      text,
    ]),
  );
  return scriptedFetch(request => {
    const url = new URL(request.url);
    expect(request.headers.get('authorization')).toBe('Bearer oauth-token');
    if (url.pathname === project) return json({ name: 'Demo', web_url: PROJECT_URL });
    if (url.pathname === `${project}/merge_requests/7`) {
      return json({ web_url: WEB_URL, diff_refs: { head_sha: 'head-sha' } });
    }
    if (url.pathname.startsWith(`${project}/repository/files/`)) {
      options.requested?.push(url.pathname);
      expect(url.searchParams.get('ref')).toBe('head-sha');
      const text = rawFiles.get(url.pathname);
      if (text === undefined) return new Response('not found', { status: 404 });
      return new Response(text, { status: 200 });
    }
    if (url.pathname === `${project}/merge_requests/7/diffs`) {
      return json(options.diffs ?? []);
    }
    return new Response('unexpected route', { status: 500 });
  });
};

const demoFile = ['const x = 1;', 'const y = 3;', 'function add(a, b) {', '  return a + b;', '}'];

const forDemo = (
  text: string,
  context: readonly {
    readonly file: string;
    readonly text: string;
    readonly symbol: string;
  }[] = [],
) =>
  Effect.gen(function* () {
    const links = yield* GitLabMergeRequestLinks;
    return yield* links.forRound({
      token: Redacted.make('oauth-token'),
      projectId: '42',
      mergeRequestIid: 7,
      target: { file: 'src/demo.ts', text },
      context,
    });
  });

describe('oldLineAt', () => {
  it('pairs added and context lines with the old line counter at that point', () => {
    const diff = ['@@ -1,1 +1,2 @@', ' a', '+b'].join('\n');
    expect(oldLineAt(diff, 1)).toBe(1);
    expect(oldLineAt(diff, 2)).toBe(2);
  });

  it('pairs context lines with both counters advancing', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' a', ' b', ' c'].join('\n');
    expect(oldLineAt(diff, 1)).toBe(1);
    expect(oldLineAt(diff, 2)).toBe(2);
    expect(oldLineAt(diff, 3)).toBe(3);
  });

  it('skips removed lines, which never match a new line', () => {
    const diff = ['@@ -1,3 +1,2 @@', ' a', '-b', ' c'].join('\n');
    expect(oldLineAt(diff, 1)).toBe(1);
    expect(oldLineAt(diff, 2)).toBe(3);
    expect(oldLineAt(diff, 3)).toBeUndefined();
  });

  it('pairs the lines of each hunk from that hunk header', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -10,2 +10,2 @@', ' j', '-k', '+K'].join(
      '\n',
    );
    // The added B follows the removed b, so it pairs with old line 3.
    expect(oldLineAt(diff, 2)).toBe(3);
    expect(oldLineAt(diff, 10)).toBe(10);
    expect(oldLineAt(diff, 11)).toBe(12);
    expect(oldLineAt(diff, 3)).toBeUndefined();
  });

  it('does not advance either counter on the no-newline marker', () => {
    const diff = [
      '@@ -1,1 +1,1 @@',
      '-a',
      '\\ No newline at end of file',
      '+a',
      '\\ No newline at end of file',
    ].join('\n');
    expect(oldLineAt(diff, 1)).toBe(2);
  });

  it('is undefined for a new line outside every hunk', () => {
    const diff = ['@@ -1,1 +1,1 @@', ' a'].join('\n');
    expect(oldLineAt(diff, 2)).toBeUndefined();
    expect(oldLineAt(diff, 0)).toBeUndefined();
  });

  it('reads a header without counts', () => {
    const diff = ['@@ -4 +4 @@', ' x', '+y'].join('\n');
    expect(oldLineAt(diff, 4)).toBe(4);
    expect(oldLineAt(diff, 5)).toBe(5);
  });

  it('is undefined for an empty diff', () => {
    expect(oldLineAt('', 1)).toBeUndefined();
  });
});

describe('lineCode', () => {
  it('joins the path SHA-1 with the old and new line', () => {
    expect(lineCode('abc123', 3, 4)).toBe('abc123_3_4');
  });
});

describe('GitLabMergeRequestLinks.forRound', () => {
  it.effect('anchors the Changes tab on the function line in the diff', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('function add(a, b) {');
      expect(links).toEqual({
        projectName: 'Demo',
        mergeRequestUrl: WEB_URL,
        functionUrl: `${WEB_URL}/diffs#${DEMO_SHA}_3_3`,
        definitionUrls: new Map(),
      });
    }).pipe(
      Effect.provide(
        withLinks(
          fakeGitLab({
            files: { 'src/demo.ts': demoFile.join('\n') },
            diffs: [{ new_path: 'src/demo.ts', diff: DEMO_DIFF }],
          }),
        ),
      ),
    ),
  );

  it.effect('falls back to the file anchor when the text is not in the file', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('function missing() {');
      expect(links.functionUrl).toBe(`${WEB_URL}/diffs#${DEMO_SHA}`);
    }).pipe(
      Effect.provide(
        withLinks(
          fakeGitLab({
            files: { 'src/demo.ts': demoFile.join('\n') },
            diffs: [{ new_path: 'src/demo.ts', diff: DEMO_DIFF }],
          }),
        ),
      ),
    ),
  );

  it.effect('falls back to the file anchor when the line is outside every hunk', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('export {};');
      expect(links.functionUrl).toBe(`${WEB_URL}/diffs#${DEMO_SHA}`);
    }).pipe(
      Effect.provide(
        withLinks(
          fakeGitLab({
            files: { 'src/demo.ts': [...demoFile, 'export {};'].join('\n') },
            diffs: [{ new_path: 'src/demo.ts', diff: DEMO_DIFF }],
          }),
        ),
      ),
    ),
  );

  it.effect('falls back to the file anchor when the file is gone at head (404)', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('function add(a, b) {');
      expect(links.functionUrl).toBe(`${WEB_URL}/diffs#${DEMO_SHA}`);
    }).pipe(
      Effect.provide(
        withLinks(fakeGitLab({ diffs: [{ new_path: 'src/demo.ts', diff: DEMO_DIFF }] })),
      ),
    ),
  );

  it.effect('falls back to the Changes tab when the file is not in the diffs', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('function add(a, b) {');
      expect(links.functionUrl).toBe(`${WEB_URL}/diffs`);
    }).pipe(
      Effect.provide(
        withLinks(
          fakeGitLab({
            files: { 'src/demo.ts': demoFile.join('\n') },
            diffs: [{ new_path: 'src/other.ts', diff: DEMO_DIFF }],
          }),
        ),
      ),
    ),
  );

  it.effect('fails as InvalidToken on 401', () =>
    Effect.gen(function* () {
      const links = yield* GitLabMergeRequestLinks;
      const error = yield* Effect.flip(
        links.forRound({
          token: Redacted.make('bad-token'),
          projectId: '42',
          mergeRequestIid: 7,
          target: { file: 'src/demo.ts', text: 'function add(a, b) {' },
          context: [],
        }),
      );
      expect(error).toBeInstanceOf(InvalidToken);
    }).pipe(
      Effect.provide(
        withLinks(
          scriptedFetch(
            () =>
              new Response(JSON.stringify({ message: '401 Unauthorized' }), {
                status: 401,
                headers: { 'content-type': 'application/json' },
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('addresses the project by its URL-encoded id', () =>
    Effect.gen(function* () {
      const links = yield* GitLabMergeRequestLinks;
      const result = yield* links.forRound({
        token: Redacted.make('oauth-token'),
        projectId: 'group/demo',
        mergeRequestIid: 7,
        target: { file: 'src/demo.ts', text: 'const x = 1;' },
        context: [],
      });
      expect(result.projectName).toBe('Demo');
    }).pipe(Effect.provide(withLinks(fakeGitLab({ projectId: 'group/demo' })))),
  );
});

describe('GitLabMergeRequestLinks.forRound definitions', () => {
  it.effect('links a multi-line definition to its first and last lines', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('export {};', [
        { file: 'src/demo.ts', text: 'function add(a, b) {\n  return a + b;\n}', symbol: 'add' },
      ]);
      expect(links.definitionUrls.get('add')).toBe(
        `${PROJECT_URL}/-/blob/head-sha/src/demo.ts#L3-5`,
      );
    }).pipe(
      Effect.provide(withLinks(fakeGitLab({ files: { 'src/demo.ts': demoFile.join('\n') } }))),
    ),
  );

  it.effect('links a one-line definition to its line', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('export {};', [
        { file: 'src/demo.ts', text: 'const x = 1;', symbol: 'x' },
      ]);
      expect(links.definitionUrls.get('x')).toBe(`${PROJECT_URL}/-/blob/head-sha/src/demo.ts#L1`);
    }).pipe(
      Effect.provide(withLinks(fakeGitLab({ files: { 'src/demo.ts': demoFile.join('\n') } }))),
    ),
  );

  it.effect('links to the file without a line when the file is gone at head', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('export {};', [
        { file: 'src/gone.ts', text: 'const gone = 1;', symbol: 'gone' },
      ]);
      expect(links.definitionUrls.get('gone')).toBe(`${PROJECT_URL}/-/blob/head-sha/src/gone.ts`);
    }).pipe(
      Effect.provide(withLinks(fakeGitLab({ files: { 'src/demo.ts': demoFile.join('\n') } }))),
    ),
  );

  it.effect('links to the file without a line when the text is not in it at head', () =>
    Effect.gen(function* () {
      const links = yield* forDemo('export {};', [
        { file: 'src/demo.ts', text: 'function missing() {', symbol: 'missing' },
      ]);
      expect(links.definitionUrls.get('missing')).toBe(
        `${PROJECT_URL}/-/blob/head-sha/src/demo.ts`,
      );
    }).pipe(
      Effect.provide(withLinks(fakeGitLab({ files: { 'src/demo.ts': demoFile.join('\n') } }))),
    ),
  );

  it.effect("fetches each distinct file once, the target's file included", () => {
    const requested: string[] = [];
    return Effect.gen(function* () {
      const links = yield* forDemo('function add(a, b) {', [
        { file: 'src/demo.ts', text: 'const x = 1;', symbol: 'x' },
        { file: 'src/demo.ts', text: 'const y = 3;', symbol: 'y' },
        { file: 'src/other.ts', text: 'export {};', symbol: 'other' },
      ]);
      expect(links.definitionUrls.get('y')).toBe(`${PROJECT_URL}/-/blob/head-sha/src/demo.ts#L2`);
      expect(requested.toSorted()).toEqual([
        '/api/v4/projects/42/repository/files/src%2Fdemo.ts/raw',
        '/api/v4/projects/42/repository/files/src%2Fother.ts/raw',
      ]);
    }).pipe(
      Effect.provide(
        withLinks(
          fakeGitLab({
            files: { 'src/demo.ts': demoFile.join('\n'), 'src/other.ts': 'export {};' },
            diffs: [{ new_path: 'src/demo.ts', diff: DEMO_DIFF }],
            requested,
          }),
        ),
      ),
    );
  });
});
