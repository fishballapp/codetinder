import { CORRECTION_STATE_FILE, QUESTIONS_SNAPSHOT_FILE } from '@codetinder/core';
import { GitLabMergeRequests, GitLabRequestFailed } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestConsole from 'effect/testing/TestConsole';
import { CLAIM_FILE } from './claim';
import { CodeTinder } from './codetinder';
import { commitsUnused, noSandboxFixMergeRequests, repositoryUnused } from './gitlab-fixture';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { runRound } from './round';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { scriptedSpawner, shellKey, tscKey } from './scripted-spawner';
import { SESSION_LOG_FILE } from './session-log';
import { TASK_FILE } from './task';
import { ID_TOKEN, MERGE_REQUEST_CONTEXT } from './trigger-context-fixture';

const TARGET = 'src/f.ts';
const ORIGINAL = 'function f() { return 1; }';
const card = (operation: string, after: string) => ({
  operation,
  change: 'Changed it.',
  principle: { id: 'p', statement: 'Do it.' },
  stance: 'supports' as const,
  kind: 'explore' as const,
  after,
});

const validAnswer = {
  target: { file: TARGET, symbol: 'f', text: ORIGINAL },
  reason: 'It shows a simple return.',
  context: [] as { file: string; symbol: string; text: string }[],
  imports: [] as string[],
  cards: [
    card('Remove Redundant Addition', 'function f() { return 1 + 0; }'),
    card('Remove Redundant Parentheses', 'function f() { return (1); }'),
    card('Replace Literal with Arithmetic', 'function f() { return 2 - 1; }'),
    card('Convert Function Declaration to Arrow Function', 'const f = () => 1;'),
    card('Extract Variable', 'function f() { const one = 1; return one; }'),
    card('Rename Variable', 'function f() { const value = 1; return value; }'),
  ],
};

const validAnswerJson = JSON.stringify(validAnswer);

const TSC = 'node_modules/.bin/tsc';
const TEMP_TSCONFIG = 'src/.codetinder-typecheck.tsconfig.json';

const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const RUN_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const baseFiles = {
  [CLAIM_FILE]: JSON.stringify({ headSha: HEAD_SHA, runId: RUN_ID }),
  'answer.json': validAnswerJson,
  [TASK_FILE]: '# Task instructions',
  [TARGET]: ORIGINAL,
  ...projectConfigFile(),
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
  [TSC]: '',
};

const passingSpawner = scriptedSpawner({
  [shellKey('npm ci')]: { exitCode: 0 },
  [shellKey('npm test')]: { exitCode: 0 },
  [tscKey(TSC, TEMP_TSCONFIG)]: { exitCode: 0, stdout: '' },
});

const withConfig = (values: Record<string, string | undefined> = {}) => {
  const defaults: Record<string, string> = {
    DUO_WORKFLOW_GOAL: '42',
    DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: MERGE_REQUEST_CONTEXT,
    DUO_WORKFLOW_PROJECT_ID: '87434709',
    CODETINDER_ID_TOKEN: ID_TOKEN,
  };
  const combined: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...defaults, ...values })) {
    if (v !== undefined) {
      combined[k] = v;
    }
  }
  return ConfigProvider.layer(ConfigProvider.fromUnknown(combined));
};

const mockGitLab = (args: {
  readonly onNote?: (args: {
    readonly projectId: string;
    readonly mergeRequestIid: number;
    readonly body: string;
  }) => Effect.Effect<void, GitLabRequestFailed>;
}) =>
  Layer.succeed(
    GitLabMergeRequests,
    GitLabMergeRequests.of({
      ...noSandboxFixMergeRequests,
      get: () =>
        Effect.succeed({
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          webUrl: 'https://gitlab.com/group/demo/-/merge_requests/1',
          isDraft: false,
          isOpen: true,
          sourceProjectId: 87434709,
          targetProjectId: 87434709,
        }),
      createMergeRequest: () => Effect.die('not used by this test'),
      replyToNote: () => Effect.die('not used by this test'),
      createNote: params =>
        (args.onNote?.(params) ?? Effect.void).pipe(
          Effect.as({ authorUsername: 'ai-codetinder-acme' }),
        ),
      finishReview: () => Effect.succeed(false),
      latestReviewRequest: () => Effect.die('not used by this test'),
    }),
  );

const provideRoundEnv = (args: {
  readonly files?: Record<string, string>;
  readonly spawner?: typeof passingSpawner;
  readonly fetch?: typeof globalThis.fetch;
  readonly onNote?: (args: {
    readonly projectId: string;
    readonly mergeRequestIid: number;
    readonly body: string;
  }) => Effect.Effect<void, GitLabRequestFailed>;
  readonly config?: Record<string, string | undefined>;
}) => {
  const fs = memoryFileSystem(args.files ?? baseFiles);
  const spawner = args.spawner ?? passingSpawner;
  const config = withConfig(args.config);
  const roundFetch =
    args.fetch ??
    scriptedFetch(
      async () =>
        new Response(JSON.stringify({ id: '0123456789AB' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
  // The claims the run gave up, by what it sent.
  const endedClaims: unknown[] = [];
  const uploads: unknown[] = [];
  const fetch = scriptedFetch(async request => {
    if (new URL(request.url).pathname === '/api/rounds') uploads.push(await request.clone().json());
    if (new URL(request.url).pathname !== '/api/claims/end') return roundFetch(request);
    endedClaims.push(await request.json());
    return new Response(null, { status: 204 });
  });

  const env = Layer.mergeAll(
    TestConsole.layer,
    Path.layer,
    Stdio.layerTest({}),
    fs.layer,
    spawner.layer,
    config,
    args.config &&
      'CODETINDER_ID_TOKEN' in args.config &&
      args.config.CODETINDER_ID_TOKEN === undefined
      ? Layer.empty
      : CodeTinder.layer.pipe(Layer.provide(withScriptedFetch(fetch)), Layer.provide(config)),
    mockGitLab({ onNote: args.onNote }),
    repositoryUnused,
    commitsUnused,
  );
  return { env, fs, endedClaims, uploads };
};

describe('runRound', () => {
  it.effect(
    'completes verified path: uploads, posts round note, deletes files, prints verified',
    () =>
      Effect.gen(function* () {
        let postedNote: { projectId: string; mergeRequestIid: number; body: string } | undefined;
        let noteCount = 0;
        const { env, fs, endedClaims, uploads } = provideRoundEnv({
          onNote: params => {
            noteCount++;
            postedNote = params;
            return Effect.void;
          },
        });

        yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

        expect(noteCount).toBe(1);
        expect(yield* TestConsole.logLines).toEqual(['verified']);
        expect(endedClaims).toEqual([]);
        expect(uploads).toEqual([
          expect.objectContaining({ mergeRequestIid: 42, headSha: HEAD_SHA, runId: RUN_ID }),
        ]);
        expect(postedNote).toBeDefined();
        expect(postedNote?.projectId).toBe('87434709');
        expect(postedNote?.mergeRequestIid).toBe(42);
        expect(postedNote?.body).toContain('https://codetinder.dev/rounds/0123456789AB');
        expect(postedNote?.body).toContain('`f`');
        expect(postedNote?.body).toContain('`@ai-codetinder-acme round`');
        expect(postedNote?.body).not.toContain('Fresh round');
        expect(fs.read('answer.json')).toBeUndefined();
        expect(fs.read(TASK_FILE)).toBeUndefined();
        expect(fs.read(SESSION_LOG_FILE)?.split('\n')).toEqual([
          '- The agent picked `f` in src/f.ts: It shows a simple return.',
          '- Typechecked 6 variants: 6 passed, 0 dropped.',
          "- Ran the project's tests on 6 variants: 6 passed, 0 dropped.",
          "- Posted the round's comment: 6 variants to swipe at https://codetinder.dev/rounds/0123456789AB.",
          '',
        ]);
      }),
  );

  it.effect("says a round that replaces the commit's earlier one is fresh", () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const { env } = provideRoundEnv({
        files: {
          ...baseFiles,
          [CLAIM_FILE]: JSON.stringify({
            headSha: HEAD_SHA,
            runId: RUN_ID,
            replacedRoundId: 'ZYXWVUTSRQPO',
          }),
        },
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(bodies).toEqual([expect.stringContaining('Fresh round')]);
      expect(yield* TestConsole.logLines).toEqual(['verified']);
    }),
  );

  it.effect('completes skip path: posts skipped note, deletes files, prints skipped', () =>
    Effect.gen(function* () {
      let postedNote: { body: string } | undefined;
      let noteCount = 0;
      const failingSpawner = scriptedSpawner({
        [shellKey('npm ci')]: {
          exitCode: 1,
          stdout:
            'npm error 403 403 Forbidden - GET https://registry.npmjs.org/vitest - Forbidden\n',
        },
      });
      const { env, fs, endedClaims } = provideRoundEnv({
        spawner: failingSpawner,
        onNote: params => {
          noteCount++;
          postedNote = params;
          return Effect.void;
        },
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(noteCount).toBe(1);
      expect(endedClaims).toEqual([{ mergeRequestIid: 42, headSha: HEAD_SHA, runId: RUN_ID }]);
      expect(yield* TestConsole.logLines).toEqual([
        'skipped: the install fails in the sandbox before any change',
      ]);
      expect(postedNote).toBeDefined();
      expect(postedNote?.body).toContain("**Your install can't run in my sandbox**");
      expect(postedNote?.body).toContain(
        'It fails before I change a thing: it tried to reach `registry.npmjs.org`, which the sandbox blocks.',
      );
      expect(fs.read('answer.json')).toBeUndefined();
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect('handles upload refused: posts skipped note with reason, deletes files', () =>
    Effect.gen(function* () {
      let postedNote: { body: string } | undefined;
      const { env, fs } = provideRoundEnv({
        fetch: scriptedFetch(
          () =>
            new Response(JSON.stringify({ _tag: 'RoundTooLarge', message: 'over 1 MiB' }), {
              status: 413,
              headers: { 'content-type': 'application/json' },
            }),
        ),
        onNote: params => {
          postedNote = params;
          return Effect.void;
        },
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        'skipped: codetinder.dev refused the round: over 1 MiB',
      ]);
      expect(postedNote?.body).toContain('Codetinder.dev refused the round: over 1 MiB.');
      expect(fs.read('answer.json')).toBeUndefined();
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect('says so when codetinder.dev refuses a round whose claim the run no longer holds', () =>
    Effect.gen(function* () {
      let postedNote: { body: string } | undefined;
      const { env } = provideRoundEnv({
        fetch: scriptedFetch(
          () =>
            new Response(
              JSON.stringify({
                _tag: 'NotClaimOwner',
                message: 'this run gave up its claim on this commit',
              }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            ),
        ),
        onNote: params => {
          postedNote = params;
          return Effect.void;
        },
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        'skipped: codetinder.dev refused the round: this run gave up its claim on this commit',
      ]);
      expect(postedNote?.body).toContain('refused the round');
    }),
  );

  it.effect(
    'handles unexpected defect: posts skipped note with defect message, deletes files',
    () =>
      Effect.gen(function* () {
        let postedNote: { body: string } | undefined;
        const defectSpawner = scriptedSpawner(() => {
          throw new Error('unexpected spawner crash');
        });
        const { env, fs } = provideRoundEnv({
          spawner: defectSpawner,
          onNote: params => {
            postedNote = params;
            return Effect.void;
          },
        });

        yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

        expect(yield* TestConsole.logLines).toEqual([
          'skipped: CodeTinder hit an unexpected error: unexpected spawner crash',
        ]);
        expect(postedNote?.body).toContain(
          'CodeTinder hit an unexpected error: unexpected spawner crash.',
        );
        expect(fs.read('answer.json')).toBeUndefined();
        expect(fs.read(TASK_FILE)).toBeUndefined();
      }),
  );

  it.effect('handles note post failure: prints failed line and deletes files', () =>
    Effect.gen(function* () {
      const { env, fs } = provideRoundEnv({
        onNote: () =>
          Effect.fail(
            new GitLabRequestFailed({
              status: 403,
              message: 'GitLab request failed with status 403',
            }),
          ),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        "failed: couldn't post the note: GitLab request failed with status 403",
      ]);
      expect(fs.read('answer.json')).toBeUndefined();
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect('handles note post defect: prints failed line and deletes files', () =>
    Effect.gen(function* () {
      const { env, fs } = provideRoundEnv({
        onNote: () => Effect.die(new Error('network connection died')),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        "failed: couldn't post the note: network connection died",
      ]);
      expect(fs.read('answer.json')).toBeUndefined();
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect('handles missing answer file: posts skipped note, deletes files, prints skipped', () =>
    Effect.gen(function* () {
      let postedNote: { body: string } | undefined;
      let noteCount = 0;
      const { env, fs } = provideRoundEnv({
        onNote: params => {
          noteCount++;
          postedNote = params;
          return Effect.void;
        },
      });

      yield* runRound('nonexistent-answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(noteCount).toBe(1);
      expect(yield* TestConsole.logLines).toEqual(['skipped: the agent gave no answer']);
      expect(postedNote).toBeDefined();
      expect(postedNote?.body).toContain('The agent gave no answer.');
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  it.effect(
    'handles missing CODETINDER_ID_TOKEN: posts skipped note, deletes files, prints skipped',
    () =>
      Effect.gen(function* () {
        let postedNote: { body: string } | undefined;
        let noteCount = 0;
        const { env, fs } = provideRoundEnv({
          config: { CODETINDER_ID_TOKEN: undefined },
          onNote: params => {
            noteCount++;
            postedNote = params;
            return Effect.void;
          },
        });

        yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

        expect(noteCount).toBe(1);
        expect(yield* TestConsole.logLines).toEqual([
          "skipped: this project's .gitlab/duo/agent-config.yml doesn't give the flow the CODETINDER_ID_TOKEN ID token",
        ]);
        expect(postedNote).toBeDefined();
        expect(postedNote?.body).toContain(
          "This project's .gitlab/duo/agent-config.yml doesn't give the flow the CODETINDER_ID_TOKEN ID token.",
        );
        expect(fs.read('answer.json')).toBeUndefined();
        expect(fs.read(TASK_FILE)).toBeUndefined();
      }),
  );

  it.effect('accepts an answer wrapped in a markdown code fence', () =>
    Effect.gen(function* () {
      let postedNote: { body: string } | undefined;
      const { env, fs } = provideRoundEnv({
        files: {
          ...baseFiles,
          'answer.json': ['```json', validAnswerJson, '```'].join('\n'),
        },
        onNote: params => {
          postedNote = params;
          return Effect.void;
        },
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual(['verified']);
      expect(postedNote?.body).toContain('https://codetinder.dev/rounds/0123456789AB');
      expect(fs.read('answer.json')).toBeUndefined();
      expect(fs.read(TASK_FILE)).toBeUndefined();
    }),
  );

  describe('with a correction to come', () => {
    const rejectedFiles = { ...baseFiles, 'answer.json': '{"nope":true}' };

    it.effect('keeps a rejected answer for the agent to correct, and ends nothing yet', () =>
      Effect.gen(function* () {
        let noteCount = 0;
        const { env, fs, endedClaims } = provideRoundEnv({
          files: rejectedFiles,
          onNote: () => Effect.sync(() => noteCount++),
        });

        yield* runRound('answer.json', { canCorrect: true }).pipe(Effect.provide(env));

        expect(yield* TestConsole.logLines).toEqual(['correct']);
        expect(noteCount).toBe(0);
        expect(endedClaims).toEqual([]);
        const correction = JSON.parse(fs.read(CORRECTION_STATE_FILE) ?? '{}');
        expect(correction).toEqual({
          task: '# Task instructions',
          answer: '{"nope":true}',
          error: expect.stringContaining('Missing key'),
        });
        expect(fs.read('answer.json')).toBeUndefined();
        expect(fs.read(TASK_FILE)).toBeUndefined();
      }),
    );

    it.effect('ends a round that passes as the last try does', () =>
      Effect.gen(function* () {
        const { env, fs } = provideRoundEnv({});

        yield* runRound('answer.json', { canCorrect: true }).pipe(Effect.provide(env));

        expect(yield* TestConsole.logLines).toEqual(['verified']);
        expect(fs.read(CORRECTION_STATE_FILE)).toBeUndefined();
      }),
    );

    it.effect("ends a skip the agent can't correct, such as a failing install, with its note", () =>
      Effect.gen(function* () {
        let noteCount = 0;
        const { env, endedClaims } = provideRoundEnv({
          spawner: scriptedSpawner({ [shellKey('npm ci')]: { exitCode: 1 } }),
          onNote: () => Effect.sync(() => noteCount++),
        });

        yield* runRound('answer.json', { canCorrect: true }).pipe(Effect.provide(env));

        expect(yield* TestConsole.logLines).toEqual([
          'skipped: the install fails in the sandbox before any change',
        ]);
        expect(noteCount).toBe(1);
        expect(endedClaims).toHaveLength(1);
      }),
    );
  });

  it.effect('ends a rejected answer on its last try with a note saying why', () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const { env, fs, endedClaims } = provideRoundEnv({
        files: { ...baseFiles, 'answer.json': '{"nope":true}' },
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        expect.stringMatching(/^skipped: the answer is invalid: Missing key/),
      ]);
      expect(bodies).toEqual([expect.stringContaining('The answer is invalid: Missing key')]);
      expect(endedClaims).toHaveLength(1);
      expect(fs.read(CORRECTION_STATE_FILE)).toBeUndefined();
    }),
  );
});

describe('runRound and the freshness budget', () => {
  const deckOn = (...principleIds: string[]) =>
    principleIds.map((principleId, index) => ({
      ...card(`Change ${index}`, `function f() { return ${index + 10}; }`),
      principle: { id: principleId, statement: `${principleId}.` },
    }));
  const questions = (ages: Record<string, number | null>) =>
    Object.entries(ages).map(([id, roundsSinceJudged]) => ({
      id,
      statement: `${id}.`,
      supports: { likes: 0, dislikes: 0 },
      opposes: { likes: 0, dislikes: 0 },
      roundsSinceJudged,
    }));
  const filesFor = (principleIds: readonly string[], ages: Record<string, number | null>) => ({
    ...baseFiles,
    'answer.json': JSON.stringify({ ...validAnswer, cards: deckOn(...principleIds) }),
    [QUESTIONS_SNAPSHOT_FILE]: JSON.stringify(questions(ages)),
  });

  const AGES = { rested0: 0, rested1: 1, rested2: 2, old: 3 };
  const FITTING = ['old', 'brand-new', 'lately', 'rested0', 'rested1', 'rested2'];
  // One eligible card against five resting ones.
  const CROWDED = ['old', 'rested0', 'rested1', 'rested2', 'rested0', 'rested1'];

  it.effect(
    'says in the note how many cards ask outside the latest judged rounds, then cleans up',
    () =>
      Effect.gen(function* () {
        const bodies: string[] = [];
        const { env, fs } = provideRoundEnv({
          files: filesFor(FITTING, AGES),
          onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
        });

        yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

        expect(yield* TestConsole.logLines).toEqual(['verified']);
        expect(bodies).toEqual([
          expect.stringContaining(
            "3 of these 6 cards explore questions outside the project's last 3 judged rounds.",
          ),
        ]);
        expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeUndefined();
      }),
  );

  it.effect('counts the cards that survive the budget, not those the agent wrote', () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const { env, uploads } = provideRoundEnv({
        files: filesFor(['old', 'brand-new', 'rested0', 'rested1', 'rested2', 'rested1'], AGES),
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      // Two eligible cards keep two of the four resting ones.
      expect(bodies).toEqual([
        expect.stringContaining(
          "2 of these 4 cards explore questions outside the project's last 3 judged rounds.",
        ),
      ]);
      expect(uploads).toEqual([
        expect.objectContaining({
          round: expect.objectContaining({
            cards: [
              expect.objectContaining({ id: 'c1' }),
              expect.objectContaining({ id: 'c2' }),
              expect.objectContaining({ id: 'c3' }),
              expect.objectContaining({ id: 'c4' }),
            ],
          }),
        }),
      ]);
    }),
  );

  it.effect('claims nothing about freshness when the questions were not read', () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const { env } = provideRoundEnv({
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual(['verified']);
      expect(bodies[0]).not.toContain('explore questions');
    }),
  );

  it.effect('hands a round with too few cards left over for its one correction', () =>
    Effect.gen(function* () {
      let noteCount = 0;
      const { env, fs, endedClaims } = provideRoundEnv({
        files: filesFor(CROWDED, AGES),
        onNote: () => Effect.sync(() => noteCount++),
      });

      yield* runRound('answer.json', { canCorrect: true }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual(['correct']);
      expect(noteCount).toBe(0);
      expect(endedClaims).toEqual([]);
      const correction = JSON.parse(fs.read(CORRECTION_STATE_FILE) ?? '{}');
      expect(correction.error).toContain('Only 2 of your cards remain after the freshness check');
      expect(correction.error).toContain('Removed ids: rested0, rested1');
      expect(correction.error).toContain('New ids: none');
      expect(correction.error).toContain('Cards remaining: 2');
      expect(correction.error).toContain('Pick another changed function');
      // The correction is checked against the same questions.
      expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeDefined();
    }),
  );

  it.effect('checks the corrected answer against the questions the first one met', () =>
    Effect.gen(function* () {
      const first = provideRoundEnv({ files: filesFor(CROWDED, AGES) });
      yield* runRound('answer.json', { canCorrect: true }).pipe(Effect.provide(first.env));
      expect(yield* TestConsole.logLines).toEqual(['correct']);

      const bodies: string[] = [];
      const survivingFiles = Object.fromEntries(
        first.fs.paths().map(path => [path, first.fs.read(path) ?? '']),
      );
      const second = provideRoundEnv({
        files: {
          ...survivingFiles,
          [TASK_FILE]: '# Task instructions',
          'answer.json': JSON.stringify({ ...validAnswer, cards: deckOn(...FITTING) }),
        },
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });
      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(second.env));

      expect((yield* TestConsole.logLines).at(-1)).toBe('verified');
      expect(bodies).toEqual([expect.stringContaining('3 of these 6 cards explore questions')]);
      expect(second.fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeUndefined();
    }),
  );

  it.effect('skips, after the correction, a round that still has too few cards left', () =>
    Effect.gen(function* () {
      const bodies: string[] = [];
      const { env, fs, endedClaims } = provideRoundEnv({
        files: filesFor(CROWDED, AGES),
        onNote: ({ body }) => Effect.sync(() => bodies.push(body)),
      });

      yield* runRound('answer.json', { canCorrect: false }).pipe(Effect.provide(env));

      expect(yield* TestConsole.logLines).toEqual([
        "skipped: only 2 card(s) are left once the questions judged in the project's last 3 judged rounds rest, and a round needs 3",
      ]);
      expect(bodies).toEqual([expect.stringContaining('Only 2 card(s) are left')]);
      expect(endedClaims).toHaveLength(1);
      expect(fs.read(QUESTIONS_SNAPSHOT_FILE)).toBeUndefined();
    }),
  );
});
