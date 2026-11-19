import {
  assignCardIds,
  CORRECTION_STATE_FILE,
  LEARN_STATE_FILES,
  oneLine,
  QUESTIONS_SNAPSHOT_FILE,
  REWRITE_STATE_FILES,
  renderPrinciplesDoc,
  SWEEP_STATE_FILES,
} from '@codetinder/core';
import { GitLabMergeRequests } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import { CodeTinder } from './codetinder';
import { noSandboxFixMergeRequests } from './gitlab-fixture';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { type ScriptedCommandResult, scriptedSpawner } from './scripted-spawner';
import { runTask, TASK_FILE } from './task';
import { MERGE_REQUEST_CONTEXT } from './trigger-context-fixture';

type MemoryFs = ReturnType<typeof memoryFileSystem>;

const escapeLikeGitLab = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

const mentionGoal = (body: string, context = 'MergeRequest IID: 7') =>
  [
    'Input: <!-- All non-system discussion messages through the triggering message are included. -->',
    `<message id="1" author="dev">${escapeLikeGitLab(body)}</message>`,
    `Context: {${context}}`,
  ].join('\n');

const round = {
  version: 2 as const,
  target: { file: 'src/f.ts', symbol: 'f', text: 'function f() { return 1; }' },
  reason: 'It branches.',
  context: [] as const,
  imports: [] as const,
  cards: assignCardIds([
    {
      operation: 'Function Declaration to Arrow Function',
      change: '`f` becomes an arrow function.',
      principle: { id: 'arrow-functions', statement: 'Write a function as an arrow function.' },
      stance: 'supports',
      kind: 'explore',
      after: 'const f = () => 1;',
    },
    {
      operation: 'Extract Variable',
      change: 'The returned value gets a name.',
      principle: { id: 'name-intermediate-values', statement: 'Name a value before returning it.' },
      stance: 'supports',
      kind: 'explore',
      after: 'function f() { const one = 1; return one; }',
    },
  ]),
};

const roundId = '0123456789AB';

const withGoal = (goal: string, extra: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DUO_WORKFLOW_GOAL: goal,
      DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: MERGE_REQUEST_CONTEXT,
      DUO_WORKFLOW_PROJECT_ID: '87434709',
      CODETINDER_ID_TOKEN: 'test-id-token',
      ...extra,
    }),
  );

const gitlabLayer = (targetBranch = 'main') =>
  Layer.succeed(
    GitLabMergeRequests,
    GitLabMergeRequests.of({
      ...noSandboxFixMergeRequests,
      get: () =>
        Effect.succeed({
          sourceBranch: 'feat/x',
          targetBranch,
          webUrl: 'https://gitlab.com/group/demo/-/merge_requests/1',
          isDraft: false,
          isOpen: true,
          sourceProjectId: 87434709,
          targetProjectId: 87434709,
        }),
      createMergeRequest: () => Effect.die('not used by this test'),
      replyToNote: () => Effect.die('not used by this test'),
      createNote: () => Effect.succeed({ authorUsername: 'ai-codetinder-acme' }),
      finishReview: () => Effect.succeed(false),
      latestReviewRequest: () => Effect.die('not used by this test'),
    }),
  );

const principlesDoc = renderPrinciplesDoc([
  {
    id: 'early-returns',
    section: 'General',
    strength: 'strong',
    statement: 'Return early on a failed check.',
  },
  {
    id: 'comprehensions',
    section: 'Python',
    strength: 'moderate',
    statement: 'Build lists with a comprehension.',
  },
]);

const learnFiles = {
  ...projectConfigFile(),
  '.codetinder/principles.md': principlesDoc,
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const provideLearn = (args: {
  readonly fetch: typeof globalThis.fetch;
  readonly fs?: MemoryFs;
  readonly goal?: string;
  readonly files?: Record<string, string>;
  readonly config?: Record<string, string>;
}) => {
  const config = withGoal(
    args.goal ?? mentionGoal(`@ai-codetinder-acme learn ${roundId}`),
    args.config,
  );
  const fs = args.fs ?? memoryFileSystem(args.files ?? learnFiles);
  return Effect.provide(
    Layer.mergeAll(
      TestConsole.layer,
      fs.layer,
      Path.layer,
      config,
      CodeTinder.layer.pipe(Layer.provide(withScriptedFetch(args.fetch)), Layer.provide(config)),
      gitlabLayer(),
      scriptedSpawner({}).layer,
      Stdio.layerTest({}),
    ),
  );
};

const roundFetch = scriptedFetch(request => {
  if (request.url.endsWith(`/api/rounds/${roundId}`)) {
    return jsonResponse(200, {
      id: roundId,
      projectId: '87434709',
      mergeRequestIid: 7,
      round,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  }
  if (request.url.endsWith(`/api/rounds/${roundId}/swipes`)) {
    return jsonResponse(200, {
      swipes: [
        {
          userId: 42,
          username: 'ada',
          verdicts: { c1: 'like', c2: 'dislike' },
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ],
    });
  }
  if (request.url.endsWith(`/api/rounds/${roundId}/evidence`)) {
    const earlierCard = (cardId: string) => ({
      ref: `ABCDEFGHIJKL/${cardId}`,
      file: 'src/g.ts',
      operation: 'Rename Function',
      change: 'Calls h instead of g.',
      diff: '@@ -1,1 +1,1 @@\n-g()\n+h()',
      likes: 1,
      dislikes: 0,
    });
    return jsonResponse(200, {
      evidence: [
        {
          id: 'early-returns',
          for: 3,
          against: 1,
          confirming: earlierCard('c2'),
          contradicting: null,
        },
        // Not in the doc: learn isn't shown it.
        {
          id: 'name-intermediate-values',
          for: 1,
          against: 0,
          confirming: earlierCard('c4'),
          contradicting: null,
        },
      ],
    });
  }
  return new Response('not found', { status: 404 });
});

const questionsResponse = () =>
  jsonResponse(200, {
    questions: [
      {
        id: 'name-intermediate-values',
        statement: 'Name an intermediate value before using it.',
        supports: { likes: 1, dislikes: 1 },
        opposes: { likes: 0, dislikes: 1 },
        roundsSinceJudged: 4,
      },
      {
        id: 'early-returns',
        statement: 'Return early.',
        supports: { likes: 2, dislikes: 0 },
        opposes: { likes: 0, dislikes: 0 },
        roundsSinceJudged: 0,
      },
    ],
  });

const generateSpawner = () =>
  scriptedSpawner({
    'git diff origin/main...HEAD': { exitCode: 0, stdout: sampleDiff },
    'git diff --name-only -z origin/main...HEAD': { exitCode: 0, stdout: 'src/f.ts\0' },
  });

/** The generate step's world: the MR's git, its files, and codetinder.dev behind `fetch`. */
const provideGenerate = (args: {
  readonly fs: MemoryFs;
  readonly goal?: string;
  readonly targetBranch?: string;
  readonly spawner?: ReturnType<typeof scriptedSpawner>;
  readonly fetch?: typeof globalThis.fetch;
  readonly hasIdToken?: boolean;
}) =>
  Effect.provide(
    Layer.mergeAll(
      TestConsole.layer,
      args.hasIdToken === false
        ? ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              DUO_WORKFLOW_GOAL: args.goal ?? '42',
              DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: MERGE_REQUEST_CONTEXT,
              DUO_WORKFLOW_PROJECT_ID: '87434709',
            }),
          )
        : withGoal(args.goal ?? '42'),
      args.fs.layer,
      Path.layer,
      gitlabLayer(args.targetBranch),
      (args.spawner ?? generateSpawner()).layer,
      withScriptedFetch(args.fetch ?? scriptedFetch(() => jsonResponse(200, { questions: [] }))),
      Stdio.layerTest({}),
    ),
  );

const STATUS = 'git status --porcelain=v1 -z --untracked-files=all';

const sampleDiff = 'diff --git a/src/f.ts b/src/f.ts\n+function f() { return 1; }';

describe('runTask', () => {
  it.effect('writes the generate task to .codetinder/task.md with diff from git', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      yield* runTask('generate').pipe(
        provideGenerate({
          fs,
          targetBranch: 'develop',
          spawner: scriptedSpawner({
            'git diff origin/develop...HEAD': { exitCode: 0, stdout: sampleDiff },
            'git diff --name-only -z origin/develop...HEAD': { exitCode: 0, stdout: 'src/f.ts\0' },
          }),
        }),
      );
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      const written = fs.read(TASK_FILE);
      expect(written).toBeDefined();
      expect(written).toContain('merge request !42');
      expect(written).toContain('## The diff');
      expect(written).toContain(sampleDiff);
      expect(written).toContain('read_file');
      expect(oneLine(written!)).toContain('never from the diff');
      expect(written).toContain('One JSON document matching this JSON Schema:');
      // No config, so no principles: the round still gets its task, all explore cards and a pair.
      expect(written).toContain(
        "## The project's coding principles\n\nNone yet, so there are no confirm or challenge cards.",
      );
    }),
  );

  it.effect("puts the project's principles and open questions in the generate task", () => {
    const requests: Request[] = [];
    return Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        '.codetinder/principles.md': principlesDoc,
      });
      yield* runTask('generate').pipe(
        provideGenerate({
          fs,
          goal: '9',
          fetch: scriptedFetch(request => {
            requests.push(request);
            return questionsResponse();
          }),
        }),
      );
      const written = fs.read(TASK_FILE);
      expect(written).toContain("## The project's coding principles");
      expect(written).toContain('- early-returns (strong): Return early on a failed check.');
      // The merge request changes only TypeScript: the Python section is left out.
      expect(written).not.toContain('Build lists with a comprehension.');
      expect(written).toContain(
        '- name-intermediate-values: Name an intermediate value before using it. (age 4; 2 for, 1 against)',
      );
      // The doc holds `early-returns`: a settled question, so it rests rather than being open.
      const [resting, open] = written!
        .split("## The project's resting questions")[1]!
        .split("## The project's open questions");
      expect(resting).toContain('- early-returns: Return early. (age 0; 2 for, 0 against)');
      expect(open).not.toContain('early-returns');
      const [request] = requests;
      expect(requests).toHaveLength(1);
      expect(new URL(request!.url).pathname).toBe('/api/projects/87434709/questions');
      expect(request!.headers.get('authorization')).toBe('Bearer test-id-token');
    });
  });

  it.effect('keeps the questions it read for the checks of the answer and of its correction', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      yield* runTask('generate').pipe(
        provideGenerate({ fs, fetch: scriptedFetch(() => questionsResponse()) }),
      );
      expect(JSON.parse(fs.read(QUESTIONS_SNAPSHOT_FILE) ?? 'null')).toEqual([
        {
          id: 'name-intermediate-values',
          statement: 'Name an intermediate value before using it.',
          supports: { likes: 1, dislikes: 1 },
          opposes: { likes: 0, dislikes: 1 },
          roundsSinceJudged: 4,
        },
        {
          id: 'early-returns',
          statement: 'Return early.',
          supports: { likes: 2, dislikes: 0 },
          opposes: { likes: 0, dislikes: 0 },
          roundsSinceJudged: 0,
        },
      ]);
    }),
  );

  it.effect('keeps no questions to speak of when the project has none: every id is new', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      yield* runTask('generate').pipe(provideGenerate({ fs }));
      expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBe('[]');
    }),
  );

  it.effect('goes on without questions, and prints nothing more, when codetinder.dev refuses', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      yield* runTask('generate').pipe(
        provideGenerate({
          fs,
          fetch: scriptedFetch(() =>
            jsonResponse(403, { _tag: 'Forbidden', message: 'not this project' }),
          ),
        }),
      );
      // The router matches this step's whole output: one more line on stderr would end the run.
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      expect(yield* TestConsole.errorLines).toEqual([]);
      expect(fs.read(TASK_FILE)).toMatch(/## The project's open questions\n\n.*\n.*\n\n\(none\)\n/);
      // Nothing was read, so the round answers to no freshness budget.
      expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeUndefined();
    }),
  );

  it.effect('goes on without questions when codetinder.dev stays unreachable', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      const fiber = yield* Effect.forkChild(
        runTask('generate').pipe(
          provideGenerate({
            fs,
            fetch: scriptedFetch(() => {
              throw new TypeError('fetch failed');
            }),
          }),
        ),
      );
      // The client retries 500 ms, 1 s and 2 s apart before it gives up.
      yield* Effect.forEach(
        Array.from({ length: 5 }),
        () => TestClock.adjust('1 second').pipe(Effect.andThen(Effect.yieldNow)),
        { discard: true },
      );
      yield* Fiber.join(fiber);
      expect(fs.read(TASK_FILE)).toContain("## The project's open questions");
      expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeUndefined();
      expect(yield* TestConsole.errorLines).toEqual([]);
    }),
  );

  it.effect('goes on without questions when codetinder.dev never answers', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      const fiber = yield* Effect.forkChild(
        runTask('generate').pipe(
          provideGenerate({ fs, fetch: scriptedFetch(() => new Promise(() => {})) }),
        ),
      );
      yield* TestClock.adjust('20 seconds');
      yield* Fiber.join(fiber);
      expect(fs.read(TASK_FILE)).toContain("## The project's open questions");
      expect(yield* TestConsole.errorLines).toEqual([]);
    }),
  );

  it.effect('goes on without questions when the flow has no ID token', () => {
    const requests: Request[] = [];
    return Effect.gen(function* () {
      const fs = memoryFileSystem();
      yield* runTask('generate').pipe(
        provideGenerate({
          fs,
          hasIdToken: false,
          fetch: scriptedFetch(request => {
            requests.push(request);
            return questionsResponse();
          }),
        }),
      );
      expect(requests).toEqual([]);
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      expect(fs.read(TASK_FILE)).toContain("## The project's open questions");
    });
  });

  it.effect('writes the rewrite task with diff and principles from the doc', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        '.codetinder/principles.md': principlesDoc,
      });
      const spawner = scriptedSpawner({
        'git diff origin/main...HEAD': { exitCode: 0, stdout: sampleDiff },
        'git diff --name-only -z origin/main...HEAD': { exitCode: 0, stdout: 'src/f.ts\0' },
        [STATUS]: { exitCode: 0, stdout: ' M src/f.ts\0?? .bashrc\0?? .vscode/settings.json\0' },
      });
      yield* runTask('rewrite').pipe(
        Effect.provide(
          Layer.mergeAll(
            TestConsole.layer,
            withGoal('9'),
            fs.layer,
            Path.layer,
            gitlabLayer('main'),
            spawner.layer,
            Stdio.layerTest({}),
          ),
        ),
      );
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      const written = fs.read(TASK_FILE);
      expect(written).toBeDefined();
      expect(written).toContain('merge request !9');
      expect(written).toContain('## The diff');
      expect(written).toContain(sampleDiff);
      expect(written).toContain('- early-returns (strong): Return early on a failed check.');
      expect(written).not.toContain('comprehensions');
      expect(fs.read(REWRITE_STATE_FILES.untrackedBefore)).toBe('.bashrc\0.vscode/settings.json\0');
    }),
  );

  it.effect('writes the retry task with the failed tests’ output', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...learnFiles,
        [REWRITE_STATE_FILES.testOutput]: 'FAIL src/f.test.ts\n  expected 1, got 2\n',
        [REWRITE_STATE_FILES.untrackedBefore]: '.bashrc\0',
      });
      const spawner = scriptedSpawner({
        'git diff origin/main...HEAD': { exitCode: 0, stdout: sampleDiff },
        'git diff --name-only -z origin/main...HEAD': { exitCode: 0, stdout: 'src/f.ts\0' },
      });
      yield* runTask('rewrite-retry').pipe(
        Effect.provide(
          Layer.mergeAll(
            TestConsole.layer,
            withGoal('9'),
            fs.layer,
            Path.layer,
            gitlabLayer('main'),
            spawner.layer,
            Stdio.layerTest({}),
          ),
        ),
      );
      const written = fs.read(TASK_FILE);
      expect(written).toContain('## The previous rewrite failed the tests');
      expect(written).toContain('FAIL src/f.test.ts\n  expected 1, got 2');
      expect(fs.read(REWRITE_STATE_FILES.untrackedBefore)).toBe('.bashrc\0');
      expect(written).toContain(sampleDiff);
      expect(written).toContain('- early-returns (strong): Return early on a failed check.');
    }),
  );

  it.effect('writes no retry task when the install or tests failed for the sandbox', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...learnFiles,
        [REWRITE_STATE_FILES.environment]:
          '{"stage":"tests","diagnosis":{"_tag":"TimedOut"},"outputTail":""}',
      });
      yield* runTask('rewrite-retry').pipe(
        Effect.provide(
          Layer.mergeAll(
            TestConsole.layer,
            withGoal('9'),
            fs.layer,
            Path.layer,
            gitlabLayer('main'),
            scriptedSpawner({}).layer,
            Stdio.layerTest({}),
          ),
        ),
      );
      expect(yield* TestConsole.logLines).toEqual([
        'no retry: the install or tests fail in the sandbox before any change',
      ]);
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect('fails the retry task with a user error without the failed tests’ output', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawner({
        'git diff origin/main...HEAD': { exitCode: 0, stdout: sampleDiff },
        'git diff --name-only -z origin/main...HEAD': { exitCode: 0, stdout: 'src/f.ts\0' },
      });
      const error = yield* runTask('rewrite-retry').pipe(
        Effect.provide(
          Layer.mergeAll(
            TestConsole.layer,
            withGoal('9'),
            memoryFileSystem(learnFiles).layer,
            Path.layer,
            gitlabLayer('main'),
            spawner.layer,
            Stdio.layerTest({}),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: `no failed rewrite to retry: can't read ${REWRITE_STATE_FILES.testOutput}`,
      });
    }),
  );

  it.effect.each(['generate-retry', 'sweep-retry'] as const)(
    'writes the %s task: the task, the rejected answer and why',
    step =>
      Effect.gen(function* () {
        const fs = memoryFileSystem({
          [CORRECTION_STATE_FILE]: JSON.stringify({
            task: '# A CodeTinder task\n',
            answer: '{"cards":[]}',
            error: 'Missing key at ["reason"]',
          }),
        });
        yield* runTask(step).pipe(
          Effect.provide(
            Layer.mergeAll(
              TestConsole.layer,
              fs.layer,
              Path.layer,
              gitlabLayer('main'),
              scriptedSpawner({}).layer,
              Stdio.layerTest({}),
            ),
          ),
        );
        const written = fs.read(TASK_FILE);
        expect(written?.startsWith('# A CodeTinder task\n')).toBe(true);
        expect(written).toContain('Missing key at ["reason"]');
        expect(written).toContain('{"cards":[]}');
        expect(yield* TestConsole.logLines).toEqual([`wrote ${TASK_FILE}`]);
      }),
  );

  it.effect('fails the correction task with a user error when there is no answer to correct', () =>
    Effect.gen(function* () {
      const error = yield* runTask('generate-retry').pipe(
        Effect.provide(
          Layer.mergeAll(
            TestConsole.layer,
            memoryFileSystem({}).layer,
            Path.layer,
            gitlabLayer('main'),
            scriptedSpawner({}).layer,
            Stdio.layerTest({}),
          ),
        ),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: `no answer to correct: can't read ${CORRECTION_STATE_FILE}`,
      });
    }),
  );

  it.effect('fails with a user error when git diff fails', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem();
      const spawner = scriptedSpawner({
        'git diff origin/main...HEAD': { exitCode: 128, stdout: '' },
      });
      const error = yield* runTask('generate').pipe(
        provideGenerate({ fs, goal: '7', spawner }),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: "can't read the merge request's diff: git diff exited 128",
      });
    }),
  );

  it.effect('writes the learn task with the swiped cards and principles', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(learnFiles);
      yield* runTask('learn').pipe(
        provideLearn({
          fs,
          fetch: roundFetch,
        }),
      );
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      const written = fs.read(TASK_FILE);
      expect(written).toBeDefined();
      expect(written).toContain('- early-returns (strong): Return early on a failed check.');
      // Learn rewrites the whole doc, so it sees every section.
      expect(written).toContain('- comprehensions (moderate): Build lists with a comprehension.');
      expect(written).toContain('### c1: 1 like, 0 dislike');
      expect(written).toContain('### c2: 0 like, 1 dislike');
      expect(written).toContain('function f() { return 1; }');
      expect(written).toContain(
        '### early-returns: 3 swipes for, 1 against\n\nA card that confirmed it: `ABCDEFGHIJKL/c2`, in `src/g.ts`, 1 like, 0 dislike',
      );
      expect(written).not.toContain('### name-intermediate-values:');
      // What a narrow may cite: the swiped cards, and the evidence shown on the doc's principles.
      expect(JSON.parse(fs.read(LEARN_STATE_FILES.citations) ?? '')).toEqual({
        c1: 1,
        c2: 1,
        'ABCDEFGHIJKL/c2': 1,
      });
    }),
  );

  it.effect("learns without earlier evidence when codetinder.dev can't give it", () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(learnFiles);
      const withoutEvidence = scriptedFetch(request =>
        request.url.endsWith('/evidence')
          ? jsonResponse(403, { _tag: 'Forbidden', message: 'another project' })
          : roundFetch(request),
      );
      yield* runTask('learn').pipe(provideLearn({ fs, fetch: withoutEvidence }));
      expect(fs.read(TASK_FILE)).toContain('### c1: 1 like, 0 dislike');
      expect(fs.read(TASK_FILE)).not.toContain('## What earlier rounds showed');
    }),
  );

  it.effect("asks to convert back a doc edited out of shape, naming the team's rules", () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...learnFiles,
        '.codetinder/principles.md': '# Our style\n\n- Never use `var`.',
        'AGENTS.md': '# Agents',
        'CONTRIBUTING.md': '# Contributing',
      });
      yield* runTask('learn').pipe(provideLearn({ fs, fetch: roundFetch }));
      const written = fs.read(TASK_FILE);
      expect(written).toContain("`.codetinder/principles.md`, was edited out of CodeTinder's");
      expect(written).toContain('- Never use `var`.');
      expect(written).toContain('in `AGENTS.md`, `CONTRIBUTING.md`.');
    }),
  );

  it.effect('asks to check the sections of a format 1 doc, which it rewrites in format 3', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...learnFiles,
        '.codetinder/principles.md': [
          '<!-- codetinder principles · format 1 · edit freely, keep the ids -->',
          '# Coding principles',
          '',
          '## early-returns · strong',
          'Return early on a failed check.',
        ].join('\n'),
      });
      yield* runTask('learn').pipe(provideLearn({ fs, fetch: roundFetch }));
      const written = fs.read(TASK_FILE);
      expect(written).toContain(
        '### General\n\n- early-returns (strong): Return early on a failed check.',
      );
      expect(written).toContain(
        "`.codetinder/principles.md`, isn't laid out as CodeTinder writes it",
      );
    }),
  );

  it.effect('fails RoundNotFound as a user error', () =>
    Effect.gen(function* () {
      const error = yield* runTask('learn').pipe(
        provideLearn({
          fetch: scriptedFetch(() =>
            jsonResponse(404, { _tag: 'RoundNotFound', message: 'no such round' }),
          ),
        }),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: 'round not found: no such round',
      });
    }),
  );

  it.effect('fails when the goal is not a learn mention', () =>
    Effect.gen(function* () {
      const error = yield* runTask('learn').pipe(
        provideLearn({
          goal: '7',
          fetch: scriptedFetch(() => {
            throw new Error('fetch must not run');
          }),
        }),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: 'UserError',
        userMessage: 'expected a learn mention naming a round',
      });
    }),
  );
});

describe('runTask on a sweep', () => {
  const BASE = 'b2'.padEnd(40, '0');
  const DIFF_U0 = `git -c core.quotePath=false diff --no-renames --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ -U0 ${BASE} HEAD`;
  const kept = [
    {
      file: 'src/cart.py',
      name: 'total',
      principleIds: ['comprehensions'],
      why: 'It builds its list in a loop.',
    },
  ];
  const sweepFiles = {
    ...learnFiles,
    [SWEEP_STATE_FILES.sweep]: JSON.stringify({
      base: BASE,
      carryOver: [{ file: 'src/tax.ts', name: 'rate' }],
    }),
    [SWEEP_STATE_FILES.picks]: JSON.stringify({ kept, left: [] }),
  };
  const runSweepStep = (
    step: 'sweep' | 'sweep-rewrite' | 'sweep-rewrite-retry',
    fs: MemoryFs,
    git: Record<string, ScriptedCommandResult> = {},
  ) =>
    runTask(step).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestConsole.layer,
          withGoal('{}'),
          fs.layer,
          Path.layer,
          gitlabLayer(),
          scriptedSpawner(git).layer,
          Stdio.layerTest({}),
        ),
      ),
    );

  it.effect('lists the code changed since the base by its added lines, and the carry-over', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(sweepFiles);
      yield* runSweepStep('sweep', fs, {
        [DIFF_U0]: {
          exitCode: 0,
          stdout: [
            'diff --git a/src/cart.py b/src/cart.py',
            '--- a/src/cart.py',
            '+++ b/src/cart.py',
            '@@ -4,0 +5,3 @@',
            '+a',
            '+b',
            '+c',
          ].join('\n'),
        },
      });
      expect(yield* TestConsole.logLines).toEqual(['wrote .codetinder/task.md']);
      const written = fs.read(TASK_FILE);
      expect(written).toContain('- `src/cart.py`: lines 5-7');
      expect(written).toContain('- `rate` in `src/tax.ts`');
      expect(written).toContain('- comprehensions (moderate): Build lists with a comprehension.');
      expect(written).not.toContain('+a');
    }),
  );

  it.effect('writes the rewrite of the kept functions, noting the untracked files first', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(sweepFiles);
      yield* runSweepStep('sweep-rewrite', fs, {
        [STATUS]: { exitCode: 0, stdout: '?? .bashrc\0' },
      });
      const written = fs.read(TASK_FILE);
      expect(written).toContain(
        '- `total` in `src/cart.py`: breaks `comprehensions`. It builds its list in a loop.',
      );
      expect(written).not.toContain('previous rewrite failed');
      expect(fs.read(REWRITE_STATE_FILES.untrackedBefore)).toBe('.bashrc\0');
    }),
  );

  it.effect("writes the sweep's retry with the failed tests' output", () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...sweepFiles,
        [REWRITE_STATE_FILES.testOutput]: 'FAIL test_cart.py',
      });
      yield* runSweepStep('sweep-rewrite-retry', fs);
      expect(fs.read(TASK_FILE)).toContain('FAIL test_cart.py');
    }),
  );

  it.effect('writes no sweep retry when the sandbox failed the tests', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...sweepFiles,
        [REWRITE_STATE_FILES.environment]:
          '{"stage":"tests","diagnosis":{"_tag":"TimedOut"},"outputTail":""}',
      });
      yield* runSweepStep('sweep-rewrite-retry', fs);
      expect(yield* TestConsole.logLines).toEqual([
        'no retry: the install or tests fail in the sandbox before any change',
      ]);
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );
});
