import {
  LEARN_RUN_FILES,
  LEARN_STATE_FILES,
  type Operation,
  type Principle,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  renderPrinciplesDoc,
  type WrittenRuleEdit,
} from '@codetinder/core';
import {
  type GitLabCommitFile,
  GitLabCommits,
  GitLabMergeRequests,
  GitLabRequestFailed,
  NoteNotFound,
} from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestConsole from 'effect/testing/TestConsole';
import { noSandboxFixMergeRequests, repositoryUnused } from './gitlab-fixture';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { runPropose } from './propose';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { type ScriptedCommandResult, scriptedSpawner } from './scripted-spawner';
import { TASK_FILE } from './task';

const ROUND_ID = '0123456789AB';
const HEAD = 'abc123';
const DOC = '.codetinder/principles.md';
const SOURCE = 'src/todos.ts';

const goalFor = (roundId: string) =>
  [
    'Input: <!-- All non-system discussion messages through the triggering message are included. -->',
    '<message id="11" author="@ai-codetinder-acme">Round ready.</message>',
    `<message id="12" author="@dev">Swiped\n\n@ai-codetinder-acme learn ${roundId}</message>`,
    'Context: {MergeRequest IID: 7}',
  ].join('\n');

const goal = goalFor(ROUND_ID);

const earlyReturns = {
  id: 'early-returns',
  section: 'General',
  strength: 'tentative',
  statement: 'Return early on a failed check.',
} as const;

/** What render keeps for propose: the principles learned, and the edits to the written rules. */
const learnedState = (
  principles: readonly Principle[],
  writtenRuleEdits: readonly WrittenRuleEdit[] = [],
) => JSON.stringify({ principles, skipped: [], writtenRuleEdits });

/** The learn agent's answer, which propose reads only to say why render left no state. */
const learnAnswer = (operations: readonly Operation[] = []) =>
  JSON.stringify({ operations, writtenRuleEdits: [] });

const CONTRIBUTING = `# Contributing

- Always write an \`else\` branch, even after a return.
- Name things clearly.
`;

const removeElseRule: WrittenRuleEdit = {
  path: 'CONTRIBUTING.md',
  rule: '- Always write an `else` branch, even after a return.\n',
  replacement: '',
  principleId: 'early-returns',
};

const rewriteAnswer = JSON.stringify({
  summary: 'Turned the nested ifs into early returns',
  appliedPrincipleIds: ['early-returns'],
});

const status = (entries: readonly string[]) => entries.map(entry => `${entry}\0`).join('');

const git = ({
  committedDoc,
  committedFiles = { 'CONTRIBUTING.md': CONTRIBUTING },
  changes = [` M ${SOURCE}`],
  mergeRequestFiles = [SOURCE],
}: {
  readonly committedDoc?: string;
  readonly committedFiles?: Record<string, string | Uint8Array>;
  readonly changes?: readonly string[];
  readonly mergeRequestFiles?: readonly string[];
}) =>
  scriptedSpawner((key): ScriptedCommandResult | undefined => {
    if (key === `git show HEAD:${DOC}`) {
      return committedDoc === undefined ? { exitCode: 128 } : { exitCode: 0, stdout: committedDoc };
    }
    if (key.startsWith('git show HEAD:')) {
      const committed = committedFiles[key.slice('git show HEAD:'.length)];
      return committed === undefined ? { exitCode: 128 } : { exitCode: 0, stdout: committed };
    }
    if (key === 'git diff --name-only -z origin/main...HEAD') {
      return { exitCode: 0, stdout: status(mergeRequestFiles) };
    }
    if (key === 'git status --porcelain=v1 -z --untracked-files=all') {
      return { exitCode: 0, stdout: status(changes) };
    }
    if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: `${HEAD}\n` };
    if (key.startsWith('git log -1 --format=%H HEAD -- ')) {
      return { exitCode: 0, stdout: `last-of-${key.split(' -- ')[1]}\n` };
    }
    return undefined;
  });

type Calls = {
  commits: { branch: string; startSha?: string; message: string; files: GitLabCommitFile[] }[];
  mergeRequests: { sourceBranch: string; targetBranch: string; title: string }[];
  replies: { noteId: number; body: string }[];
  notes: string[];
  /** What the run reported to codetinder.dev about the learn. */
  reports: unknown[];
};

const gitlab = ({
  calls,
  isPushRefused = false,
  isNoteGone = false,
  isCommitRefused = false,
}: {
  readonly calls: Calls;
  readonly isPushRefused?: boolean;
  readonly isNoteGone?: boolean;
  readonly isCommitRefused?: boolean;
}) =>
  Layer.mergeAll(
    Layer.succeed(
      GitLabMergeRequests,
      GitLabMergeRequests.of({
        ...noSandboxFixMergeRequests,
        get: () =>
          Effect.succeed({
            sourceBranch: 'feat/rename',
            targetBranch: 'main',
            webUrl: 'https://gitlab.com/acme/app/-/merge_requests/7',
            isDraft: false,
            isOpen: true,
            sourceProjectId: 87434709,
            targetProjectId: 87434709,
          }),
        createMergeRequest: ({ sourceBranch, targetBranch, title }) =>
          Effect.sync(() => {
            calls.mergeRequests.push({ sourceBranch, targetBranch, title });
            return { iid: 8, webUrl: 'https://gitlab.com/acme/app/-/merge_requests/8' };
          }),
        createNote: ({ body }) =>
          Effect.sync(() => {
            calls.notes.push(body);
            return { authorUsername: 'ai-codetinder-acme' };
          }),
        finishReview: () => Effect.succeed(false),
        latestReviewRequest: () => Effect.die('not used by this test'),
        replyToNote: ({ noteId, body }) =>
          isNoteGone
            ? Effect.fail(new NoteNotFound({ noteId, message: 'gone' }))
            : Effect.sync(() => void calls.replies.push({ noteId, body })),
      }),
    ),
    Layer.succeed(
      GitLabCommits,
      GitLabCommits.of({
        commit: ({ branch, startSha, message, files }) => {
          if (isCommitRefused || (isPushRefused && branch === 'feat/rename')) {
            return Effect.fail(
              new GitLabRequestFailed({ status: 400, message: 'POST commits failed with 400' }),
            );
          }
          return Effect.sync(() => {
            calls.commits.push({
              branch,
              message,
              files: [...files],
              ...(startSha === undefined ? {} : { startSha }),
            });
            return { id: 'def456', webUrl: 'https://gitlab.com/acme/app/-/commit/def456' };
          });
        },
      }),
    ),
  );

const run = ({
  files,
  spawner = git({}),
  goal: runGoal = goal,
  ...options
}: {
  readonly files: Record<string, string>;
  readonly spawner?: ReturnType<typeof scriptedSpawner>;
  readonly goal?: string;
  readonly isPushRefused?: boolean;
  readonly isNoteGone?: boolean;
  readonly isCommitRefused?: boolean;
}) =>
  Effect.gen(function* () {
    const fs = memoryFileSystem(files);
    const calls: Calls = { commits: [], mergeRequests: [], replies: [], notes: [], reports: [] };
    const fetch = scriptedFetch(async request => {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== `/api/rounds/${ROUND_ID}/learn`) {
        throw new Error(`unexpected request: ${request.method} ${url.pathname}`);
      }
      calls.reports.push(await request.json());
      return new Response(null, { status: 204 });
    });
    yield* runPropose().pipe(
      Effect.provide(
        Layer.mergeAll(
          fs.layer,
          spawner.layer,
          Path.layer,
          Stdio.layerTest({}),
          TestConsole.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              DUO_WORKFLOW_GOAL: runGoal,
              DUO_WORKFLOW_PROJECT_ID: '123',
              CODETINDER_ID_TOKEN: 'test-id-token',
            }),
          ),
          withScriptedFetch(fetch),
          gitlab({ calls, ...options }),
          repositoryUnused,
        ),
      ),
    );
    return { fs, calls, verdict: (yield* TestConsole.logLines).at(-1) };
  });

const learned = {
  ...projectConfigFile(),
  [TASK_FILE]: '# task',
  [LEARN_RUN_FILES.principlesAnswer]: learnAnswer(),
  [LEARN_STATE_FILES.principles]: learnedState([earlyReturns]),
  [REWRITE_RUN_FILES.rewriteAnswer]: rewriteAnswer,
  [REWRITE_STATE_FILES.verdict]: 'verified\n',
  [REWRITE_STATE_FILES.testCommand]: 'npm test\n',
  [SOURCE]: 'rewritten source',
};

describe('runPropose', () => {
  it.effect('opens an MR into the round MR with the doc and the rewrite, and says so', () =>
    Effect.gen(function* () {
      const { fs, calls, verdict } = yield* run({ files: learned });

      expect(calls.commits).toEqual([
        {
          branch: `codetinder/learn-${ROUND_ID}-0`,
          startSha: HEAD,
          message: expect.stringContaining(`round ${ROUND_ID}`),
          files: [
            { path: DOC, content: renderPrinciplesDoc([earlyReturns]), action: 'create' },
            { path: SOURCE, content: 'rewritten source', action: 'update' },
          ],
        },
      ]);
      expect(calls.mergeRequests).toEqual([
        {
          sourceBranch: `codetinder/learn-${ROUND_ID}-0`,
          targetBranch: 'feat/rename',
          title: expect.stringContaining('!7'),
        },
      ]);
      expect(calls.replies).toEqual([
        {
          noteId: 12,
          body: expect.stringContaining('**!8**'),
        },
      ]);
      expect(verdict).toBe('proposed');
      expect(calls.reports).toEqual([{ noteId: 12, report: 'Finished' }]);
      // The repo keeps only its own files; the run's state outside it goes with the runner.
      expect(fs.paths().filter(path => !path.startsWith('/tmp/'))).toEqual([
        '.codetinder/config.json',
        SOURCE,
      ]);
    }),
  );

  it.effect("pushes onto the MR's branch when the config says push and it hasn't moved", () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, ...projectConfigFile({ proposal: 'push' }) },
      });
      expect(calls.commits).toEqual([
        {
          branch: 'feat/rename',
          message: expect.any(String),
          files: [
            { path: DOC, content: renderPrinciplesDoc([earlyReturns]), action: 'create' },
            {
              path: SOURCE,
              content: 'rewritten source',
              action: 'update',
              lastCommitId: `last-of-${SOURCE}`,
            },
          ],
        },
      ]);
      expect(calls.mergeRequests).toEqual([]);
      expect(calls.replies[0]?.body).toContain('https://gitlab.com/acme/app/-/commit/def456');
    }),
  );

  it.effect('commits a written rule the swipes contradict, rewritten, and names it', () =>
    Effect.gen(function* () {
      const answer = learnedState([earlyReturns], [removeElseRule]);
      const { calls } = yield* run({
        files: {
          ...learned,
          ...projectConfigFile({ proposal: 'push' }),
          [LEARN_STATE_FILES.principles]: answer,
          // The checkout's copy is ignored: the edit applies to the file as committed.
          'CONTRIBUTING.md': 'edited by the agent',
        },
      });
      expect(calls.commits[0]?.files).toContainEqual({
        path: 'CONTRIBUTING.md',
        content: '# Contributing\n\n- Name things clearly.\n',
        action: 'update',
        lastCommitId: 'last-of-CONTRIBUTING.md',
      });
      expect(calls.commits[0]?.message).toContain(
        '- removed a rule in CONTRIBUTING.md that early-returns contradicts',
      );
      expect(calls.replies[0]?.body).toContain(
        '- Updated `CONTRIBUTING.md`: removed the rule “- Always write an `else` branch, even after a return.”, which `early-returns` contradicts.',
      );
    }),
  );

  it.effect('proposes a written rule edit alone, even when the doc and the code are settled', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({
        files: {
          ...learned,
          [LEARN_STATE_FILES.principles]: learnedState([earlyReturns], [removeElseRule]),
        },
        spawner: git({ committedDoc: renderPrinciplesDoc([earlyReturns]), changes: [] }),
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual(['CONTRIBUTING.md']);
      expect(verdict).toBe('proposed');
    }),
  );

  it.effect(
    'skips an edit to a file the rewrite changed, or one that does not apply, and says so',
    () =>
      Effect.gen(function* () {
        const edits: WrittenRuleEdit[] = [
          { ...removeElseRule, path: 'AGENTS.md', rule: 'Anything.' },
          { ...removeElseRule, rule: 'Not in the file.' },
        ];
        const { calls } = yield* run({
          files: {
            ...learned,
            [LEARN_STATE_FILES.principles]: learnedState([earlyReturns], edits),
            'AGENTS.md': 'rewritten',
          },
          spawner: git({
            committedFiles: { 'CONTRIBUTING.md': CONTRIBUTING, 'AGENTS.md': 'Anything.' },
            changes: [` M ${SOURCE}`, ' M AGENTS.md'],
            mergeRequestFiles: [SOURCE, 'AGENTS.md'],
          }),
        });
        expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC, SOURCE, 'AGENTS.md']);
        const body = calls.replies[0]?.body ?? '';
        expect(body).toContain(
          "Couldn't update `AGENTS.md` (the file isn't one this proposal may change)",
        );
        expect(body).toContain(
          "Couldn't update `CONTRIBUTING.md` (the rule isn't in the file as quoted)",
        );
      }),
  );

  it.effect('still names a skipped edit when there is nothing else to propose', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({
        files: {
          ...learned,
          [LEARN_STATE_FILES.principles]: learnedState(
            [earlyReturns],
            [{ ...removeElseRule, rule: 'Not in the file.' }],
          ),
        },
        spawner: git({ committedDoc: renderPrinciplesDoc([earlyReturns]), changes: [] }),
      });
      expect(calls.commits).toEqual([]);
      expect(verdict).toBe('nothing to propose');
      expect(calls.replies[0]?.body).toContain(
        "Couldn't update `CONTRIBUTING.md` (the rule isn't in the file as quoted)",
      );
    }),
  );

  it.effect('skips an edit to a file that is not UTF-8, leaving it as it is', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: {
          ...learned,
          [LEARN_STATE_FILES.principles]: learnedState([earlyReturns], [removeElseRule]),
        },
        spawner: git({
          committedFiles: { 'CONTRIBUTING.md': new Uint8Array([0x2d, 0x20, 0xe9, 0x0a]) },
        }),
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC, SOURCE]);
      expect(calls.replies[0]?.body).toContain(
        "Couldn't update `CONTRIBUTING.md` (the file isn't UTF-8 text)",
      );
    }),
  );

  it.effect('edits a file with a byte order mark and CRLF line endings, keeping both', () =>
    Effect.gen(function* () {
      const crlf = `\uFEFF${CONTRIBUTING.replaceAll('\n', '\r\n')}`;
      const { calls } = yield* run({
        files: {
          ...learned,
          [LEARN_STATE_FILES.principles]: learnedState([earlyReturns], [removeElseRule]),
        },
        spawner: git({ committedFiles: { 'CONTRIBUTING.md': crlf } }),
      });
      expect(calls.commits[0]?.files).toContainEqual({
        path: 'CONTRIBUTING.md',
        content: '\uFEFF# Contributing\r\n\r\n- Name things clearly.\r\n',
        action: 'update',
      });
    }),
  );

  it.effect('opens an MR instead when GitLab refuses the push, as a file changed since', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, ...projectConfigFile({ proposal: 'push' }) },
        isPushRefused: true,
      });
      expect(calls.commits.map(({ branch }) => branch)).toEqual([`codetinder/learn-${ROUND_ID}-0`]);
      expect(calls.mergeRequests).toHaveLength(1);
      expect(calls.replies[0]?.body).toContain('GitLab turned me down');
    }),
  );

  it.effect('proposes only the principles when the rewrite failed the tests', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, [REWRITE_STATE_FILES.verdict]: 'failed: tests failed\n' },
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC]);
      expect(calls.replies[0]?.body).toContain('The tests failed on it, twice.');
    }),
  );

  it.effect('says which test command passed on the rewrite, as verify recorded it', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, [REWRITE_STATE_FILES.testCommand]: 'pnpm test\n' },
      });
      expect(calls.replies[0]?.body).toContain('I ran `pnpm test` on it, and it passed.');
    }),
  );

  it.effect('fails when the rewrite passed but no test command was recorded', () =>
    Effect.gen(function* () {
      const { [REWRITE_STATE_FILES.testCommand]: _, ...files } = learned;
      const { verdict } = yield* run({ files });
      expect(verdict).toBe(
        `failed: the rewrite was verified, but ${REWRITE_STATE_FILES.testCommand} is missing`,
      );
    }),
  );

  it.effect('says the sandbox blocked the tests when verify found the environment at fault', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: {
          ...learned,
          [REWRITE_STATE_FILES.verdict]:
            'failed: the tests fail in the sandbox before any change\n',
          [REWRITE_STATE_FILES.environment]: JSON.stringify({
            stage: 'tests',
            diagnosis: { _tag: 'BlockedHosts', hosts: ['api.example.com'] },
            outputTail: 'Error: getaddrinfo ENOTFOUND api.example.com',
          }),
        },
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC]);
      expect(calls.replies[0]?.body).toContain(
        'They tried to reach `api.example.com`, which the sandbox blocks.',
      );
      expect(calls.replies[0]?.body).not.toContain('The tests failed on it, twice.');
    }),
  );

  it.effect(
    "keeps a sandbox failure's cause when the swipes confirmed the doc and nothing else changed",
    () =>
      Effect.gen(function* () {
        const { calls, verdict } = yield* run({
          files: {
            ...learned,
            [REWRITE_STATE_FILES.verdict]:
              'failed: the tests fail in the sandbox before any change\n',
            [REWRITE_STATE_FILES.environment]: JSON.stringify({
              stage: 'tests',
              diagnosis: { _tag: 'BlockedHosts', hosts: ['api.example.com'] },
              outputTail: 'Error: getaddrinfo ENOTFOUND api.example.com',
            }),
          },
          spawner: git({ committedDoc: renderPrinciplesDoc([earlyReturns]), changes: [] }),
        });
        expect(calls.commits).toEqual([]);
        expect(verdict).toBe('nothing to propose');
        expect(calls.replies[0]?.body).toContain('**Nothing to propose this time**');
        expect(calls.replies[0]?.body).toContain(
          'They tried to reach `api.example.com`, which the sandbox blocks.',
        );
      }),
  );

  it.effect("never commits a file outside the rewrite's scope", () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, 'src/other.ts': 'sneaky' },
        spawner: git({ changes: [` M ${SOURCE}`, ' M src/other.ts', '?? .bashrc'] }),
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC, SOURCE]);
    }),
  );

  it.effect('has nothing to propose when the swipes confirm the doc and the code follows it', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({
        files: learned,
        spawner: git({ committedDoc: renderPrinciplesDoc([earlyReturns]), changes: [] }),
      });
      expect(calls.commits).toEqual([]);
      expect(calls.replies[0]?.body).toContain('Nothing to change');
      expect(verdict).toBe('nothing to propose');
    }),
  );

  it.effect('proposes a doc edited out of shape converted back, even with the code unchanged', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({
        files: learned,
        spawner: git({ committedDoc: '# Style\n\n- Return early.', changes: [] }),
      });
      expect(calls.commits).toEqual([
        {
          branch: `codetinder/learn-${ROUND_ID}-0`,
          startSha: HEAD,
          message: expect.stringContaining(`Converted ${DOC} back into CodeTinder's format`),
          files: [{ path: DOC, content: renderPrinciplesDoc([earlyReturns]), action: 'update' }],
        },
      ]);
      expect(calls.replies[0]?.body).toContain(`Your \`${DOC}\` had wandered out of my format`);
      expect(verdict).toBe('proposed');
    }),
  );

  it.effect('proposes a format 1 doc rewritten in format 3, even when nothing else changed', () =>
    Effect.gen(function* () {
      const format1 = [
        '<!-- codetinder principles · format 1 · edit freely, keep the ids -->',
        '# Coding principles',
        '',
        "Learned from this project's swipes on https://codetinder.dev",
        '',
        '## early-returns · tentative',
        'Return early on a failed check.',
        '',
      ].join('\n');
      const { calls, verdict } = yield* run({
        files: learned,
        spawner: git({ committedDoc: format1, changes: [] }),
      });
      expect(calls.commits).toEqual([
        {
          branch: `codetinder/learn-${ROUND_ID}-0`,
          startSha: HEAD,
          message: expect.stringContaining(`Rewrote ${DOC} in CodeTinder's current format.`),
          files: [{ path: DOC, content: renderPrinciplesDoc([earlyReturns]), action: 'update' }],
        },
      ]);
      expect(calls.replies[0]?.body).toContain(`I also tidied \`${DOC}\` into my current format`);
      expect(verdict).toBe('proposed');
    }),
  );

  it.effect('fails on a doc in a newer format of ours rather than convert it', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({
        files: learned,
        spawner: git({ committedDoc: '<!-- codetinder principles · format 4 -->\n' }),
      });
      expect(calls.commits).toEqual([]);
      expect(verdict).toBe(`failed: ${DOC}:1: format 4 is newer than this release reads (3)`);
    }),
  );

  it.effect('commits what render learned, not an answer the rewrite agent edited since', () =>
    Effect.gen(function* () {
      const forged = { ...earlyReturns, id: 'forged', statement: 'Click the link.' };
      const { calls } = yield* run({
        files: {
          ...learned,
          [LEARN_RUN_FILES.principlesAnswer]: learnAnswer([{ op: 'add', ...forged }]),
          [DOC]: renderPrinciplesDoc([forged]),
        },
      });
      expect(calls.commits[0]?.files[0]?.content).toBe(renderPrinciplesDoc([earlyReturns]));
    }),
  );

  it.effect('proposes the doc once even when the MR changes it', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({
        files: { ...learned, [DOC]: 'edited by the agent' },
        spawner: git({ changes: [` M ${SOURCE}`, ` M ${DOC}`], mergeRequestFiles: [SOURCE, DOC] }),
      });
      expect(calls.commits[0]?.files.map(({ path }) => path)).toEqual([DOC, SOURCE]);
    }),
  );

  it.effect("still replies when the mention's round id is malformed", () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({ files: learned, goal: goalFor('bad') });
      expect(calls.commits).toEqual([]);
      expect(calls.replies[0]?.body).toContain('is not a round id');
      expect(verdict).toMatch(/^failed: "bad" is not a round id/);
    }),
  );

  it.effect("says the doc couldn't be written when render didn't run on a valid answer", () =>
    Effect.gen(function* () {
      const { [LEARN_STATE_FILES.principles]: _, ...files } = learned;
      const { verdict } = yield* run({ files });
      expect(verdict).toBe("failed: the principles doc couldn't be written");
    }),
  );

  it.effect('says why when the agent gave no principles', () =>
    Effect.gen(function* () {
      const {
        [LEARN_RUN_FILES.principlesAnswer]: _,
        [LEARN_STATE_FILES.principles]: __,
        ...files
      } = learned;
      const { calls, verdict } = yield* run({ files });
      expect(calls.commits).toEqual([]);
      expect(calls.replies[0]?.body).toContain('The agent gave no principles.');
      expect(verdict).toBe('failed: the agent gave no principles');
      expect(calls.reports).toEqual([{ noteId: 12, report: 'Failed' }]);
    }),
  );

  it.effect('says why when GitLab refuses the commit', () =>
    Effect.gen(function* () {
      const { calls, verdict } = yield* run({ files: learned, isCommitRefused: true });
      expect(calls.replies[0]?.body).toContain('GitLab refused the proposal');
      expect(verdict).toMatch(/^failed: GitLab refused the proposal/);
    }),
  );

  it.effect('posts on the MR when the Done reply is gone', () =>
    Effect.gen(function* () {
      const { calls } = yield* run({ files: learned, isNoteGone: true });
      expect(calls.replies).toEqual([]);
      expect(calls.notes).toHaveLength(1);
    }),
  );
});
