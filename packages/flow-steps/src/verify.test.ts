import {
  QUESTIONS_SNAPSHOT_FILE,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  SWEEP_RUN_FILES,
  SWEEP_STATE_FILES,
} from '@codetinder/core';
import { GitLabMergeRequests } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import type * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import type * as Path from 'effect/Path';
import * as PathModule from 'effect/Path';
import type * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner';
import * as Stdio from 'effect/Stdio';
import * as TestClock from 'effect/testing/TestClock';
import * as TestConsole from 'effect/testing/TestConsole';
import { noSandboxFixMergeRequests } from './gitlab-fixture';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { type ScriptedCommandResult, scriptedSpawner, shellKey, tscKey } from './scripted-spawner';
import { MERGE_REQUEST_CONTEXT } from './trigger-context-fixture';
import { runVerifyRewrite, runVerifySweep, verifyRound } from './verify';

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

const cards = [
  card('Remove Redundant Addition', 'function f() { return 1 + 0; }'),
  card('Remove Redundant Parentheses', 'function f() { return (1); }'),
  card('Replace Literal with Arithmetic', 'function f() { return 2 - 1; }'),
  card('Convert Function Declaration to Arrow Function', 'const f = () => 1;'),
  card('Extract Variable', 'function f() { const one = 1; return one; }'),
  card('Rename Variable', 'function f() { const value = 1; return value; }'),
];

const answer = {
  target: { file: TARGET, symbol: 'f', text: ORIGINAL },
  reason: 'It shows a simple return.',
  context: [] as { file: string; symbol: string; text: string }[],
  imports: [] as string[],
  cards,
};

const answerJson = JSON.stringify(answer);

const TSC = 'node_modules/.bin/tsc';
const TEMP_TSCONFIG = 'src/.codetinder-typecheck.tsconfig.json';

const baseFiles = {
  'answer.json': answerJson,
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

type RoundEnv =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | Stdio.Stdio;

const provideRound = (
  fsLayer: Layer.Layer<FileSystem.FileSystem>,
  spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
): Layer.Layer<RoundEnv> =>
  Layer.mergeAll(TestConsole.layer, PathModule.layer, Stdio.layerTest({}), fsLayer, spawnerLayer);

describe('verifyRound', () => {
  it.effect('rejects the answer when the pick is not found', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        [TARGET]: 'function other() {}',
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Rejected',
        reason: 'the function is not found in src/f.ts',
        error: 'the function is not found in src/f.ts',
      });
    }),
  );

  it.effect('rejects the answer when the pick is found twice', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        [TARGET]: `${ORIGINAL}\n${ORIGINAL}`,
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Rejected',
        reason: 'the function is found more than once in src/f.ts',
        error: 'the function is found more than once in src/f.ts',
      });
    }),
  );

  it.effect('skips when the config is missing', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        'answer.json': answerJson,
        [TARGET]: ORIGINAL,
        'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
        [TSC]: '',
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: 'this project has no .codetinder/config.json',
      });
    }),
  );

  it.effect('skips with the blocked host when install fails in the sandbox', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const spawner = scriptedSpawner({
        [shellKey('npm ci')]: {
          exitCode: 1,
          stdout:
            'npm error 403 403 Forbidden - GET https://registry.npmjs.org/vitest - Forbidden\n',
        },
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: 'the install fails in the sandbox before any change',
        environment: {
          stage: 'install',
          diagnosis: { _tag: 'BlockedHosts', hosts: ['registry.npmjs.org'] },
          outputTail:
            'npm error 403 403 Forbidden - GET https://registry.npmjs.org/vitest - Forbidden',
          command: 'npm ci',
          exitCode: 1,
        },
      });
    }),
  );

  it.effect('runs the install on the Node and pnpm the root package.json pins', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        ...projectConfigFile({ install: 'pnpm install --frozen-lockfile', test: 'pnpm test' }),
        'pnpm-lock.yaml': '',
        'package.json': JSON.stringify({
          packageManager: 'pnpm@12.6.0',
          engines: { node: '>=26' },
        }),
      });
      const pinnedInstall =
        "npx --yes --foreground-scripts -p node@26 -p pnpm@12.6.0 -- sh -c 'pnpm install --frozen-lockfile'";
      const ran: string[] = [];
      const spawner = scriptedSpawner(key => {
        ran.push(key);
        return key === shellKey(pinnedInstall) ? { exitCode: 1, stdout: '' } : undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome).toMatchObject({
        _tag: 'Skipped',
        reason: 'the install fails in the sandbox before any change',
      });
      expect(ran).toEqual([shellKey(pinnedInstall)]);
    }),
  );

  it.effect('stops a check still running at its deadline and skips as timed out', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const spawner = scriptedSpawner({ [shellKey('npm ci')]: { exitCode: 0, hangs: true } });
      const running = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
        Effect.forkChild,
      );
      yield* TestClock.adjust('28 minutes');
      expect(yield* Fiber.join(running)).toEqual({
        _tag: 'Skipped',
        reason: 'the tests fail in the sandbox before any change',
        environment: { stage: 'tests', diagnosis: { _tag: 'TimedOut' }, outputTail: '' },
      });
    }),
  );

  it.effect(
    "rejects the answer with each of tsc's errors when the original fails the typecheck",
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem(baseFiles);
        const spawner = scriptedSpawner({
          [shellKey('npm ci')]: { exitCode: 0 },
          [tscKey(TSC, TEMP_TSCONFIG)]: {
            exitCode: 2,
            stdout: [
              'src/.codetinder-typecheck-original.ts(1,1): error TS2304: Cannot find name.',
              'src/.codetinder-typecheck-original.ts(1,16): error TS2322: Type mismatch.',
              '',
            ].join('\n'),
          },
        });
        const outcome = yield* verifyRound('answer.json').pipe(
          Effect.provide(provideRound(fs.layer, spawner.layer)),
        );
        expect(outcome).toEqual({
          _tag: 'Rejected',
          reason:
            "the picked function doesn't typecheck with its context: error TS2304: Cannot find name.",
          error: [
            `error TS2304: Cannot find name.\n  at: ${ORIGINAL}`,
            `error TS2322: Type mismatch.\n  at: ${ORIGINAL}`,
          ].join('\n'),
        });
        expect(fs.paths().filter(p => p.includes('.codetinder-typecheck'))).toEqual([]);
      }),
  );

  it.effect(
    'drops a card that fails the typecheck or the tests, then skips with too few left',
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem(baseFiles);
        // The tests run in order over the five cards that pass the typecheck, then over the unchanged
        // code: cards 2, 4 and 5 fail, so two are left.
        const exitCodes = [0, 1, 1, 1, 0, 0];
        let testRuns = 0;
        const spawner = scriptedSpawner(key => {
          if (key === shellKey('npm ci')) return { exitCode: 0 };
          if (key === tscKey(TSC, TEMP_TSCONFIG)) {
            return {
              exitCode: 2,
              stdout: 'src/.codetinder-typecheck-card-3.ts(1,1): error TS2322: Type mismatch.\n',
            };
          }
          if (key === shellKey('npm test')) {
            const exitCode = exitCodes[testRuns] ?? 1;
            testRuns += 1;
            return { exitCode };
          }
          return undefined;
        });
        const outcome = yield* verifyRound('answer.json').pipe(
          Effect.provide(provideRound(fs.layer, spawner.layer)),
        );
        expect(outcome).toEqual({
          _tag: 'Skipped',
          reason: 'only 2 card(s) passed the typecheck and tests, and a round needs 3',
        });
        expect(fs.read(TARGET)).toBe(ORIGINAL);
        const errors = (yield* TestConsole.errorLines).map(String);
        expect(errors).toContain('card 3 (Replace Literal with Arithmetic): typecheck failed');
        expect(
          errors.some(line => line.startsWith('card 1 (Remove Redundant Addition): exit 0 in ')),
        ).toBe(true);
        expect(
          errors.some(line => line.startsWith('card 2 (Remove Redundant Parentheses): exit 1 in ')),
        ).toBe(true);
      }),
  );

  it.effect('skips when fewer than 3 cards survive the tests', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      // The tests run in order over all six cards, of which only the first two pass, then over the
      // unchanged code, which passes too.
      const exitCodes = [0, 0, 1, 1, 1, 1, 0];
      let testRuns = 0;
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === tscKey(TSC, TEMP_TSCONFIG)) return { exitCode: 0, stdout: '' };
        if (key === shellKey('npm test')) {
          const exitCode = exitCodes[testRuns] ?? 1;
          testRuns += 1;
          return { exitCode };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: 'only 2 card(s) passed the typecheck and tests, and a round needs 3',
      });
      expect(fs.read(TARGET)).toBe(ORIGINAL);
    }),
  );

  it.effect('verifies a round of exactly the minimum of cards', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const exitCodes = [0, 1, 0, 1, 0, 1];
      let testRuns = 0;
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === tscKey(TSC, TEMP_TSCONFIG)) return { exitCode: 0, stdout: '' };
        if (key === shellKey('npm test')) {
          const exitCode = exitCodes[testRuns] ?? 0;
          testRuns += 1;
          return { exitCode };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      if (outcome._tag === 'Verified') {
        expect(outcome.round.cards.map(c => c.operation)).toEqual([
          'Remove Redundant Addition',
          'Replace Literal with Arithmetic',
          'Extract Variable',
        ]);
      }
    }),
  );

  it.effect('keeps a consistency card whose other half was dropped, unpaired', () =>
    Effect.gen(function* () {
      const pair = [
        { ...cards[0], kind: 'consistency', principle: { id: 'arrows', statement: 'Use arrows.' } },
        ...cards.slice(1, 4),
        {
          ...cards[4],
          kind: 'consistency',
          stance: 'opposes',
          principle: { id: 'arrows', statement: 'Use arrows.' },
        },
        cards[5],
      ];
      const fs = memoryFileSystem({
        ...baseFiles,
        'answer.json': JSON.stringify({ ...answer, cards: pair }),
      });
      // The second consistency card, the fifth, fails the tests; the first, the other half, passes.
      const exitCodes = [0, 0, 0, 0, 1, 0];
      let testRuns = 0;
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === tscKey(TSC, TEMP_TSCONFIG)) return { exitCode: 0, stdout: '' };
        if (key === shellKey('npm test')) {
          const exitCode = exitCodes[testRuns] ?? 0;
          testRuns += 1;
          return { exitCode };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      if (outcome._tag === 'Verified') {
        expect(outcome.round.cards.map(c => [c.kind, c.stance])).toEqual([
          ['consistency', 'supports'],
          ['explore', 'supports'],
          ['explore', 'supports'],
          ['explore', 'supports'],
          ['explore', 'supports'],
        ]);
      }
    }),
  );

  it.effect(
    'blames the sandbox when fewer than 3 cards pass and the unchanged code fails too',
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem(baseFiles);
        const spawner = scriptedSpawner({
          [shellKey('npm ci')]: { exitCode: 0 },
          [tscKey(TSC, TEMP_TSCONFIG)]: { exitCode: 0, stdout: '' },
          [shellKey('npm test')]: {
            exitCode: 1,
            stdout: ' FAIL  src/f.test.ts\nTest timed out in 5000ms.\n',
          },
        });
        const outcome = yield* verifyRound('answer.json').pipe(
          Effect.provide(provideRound(fs.layer, spawner.layer)),
        );
        expect(outcome).toEqual({
          _tag: 'Skipped',
          reason: 'the tests fail in the sandbox before any change',
          environment: {
            stage: 'tests',
            diagnosis: { _tag: 'TimedOut' },
            outputTail: ' FAIL  src/f.test.ts\nTest timed out in 5000ms.',
            command: 'npm test',
            exitCode: 1,
          },
        });
        expect(fs.read(TARGET)).toBe(ORIGINAL);
      }),
  );

  it.effect('verifies the round on success, restores the target, and removes temps', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      if (outcome._tag === 'Verified') {
        expect(outcome.round.version).toBe(2);
        expect(outcome.round.cards.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
      }
      expect(fs.read(TARGET)).toBe(ORIGINAL);
      expect(fs.paths().filter(p => p.includes('.codetinder-typecheck'))).toEqual([]);
    }),
  );

  it.effect('accepts an answer wrapped in a markdown code fence', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        'answer.json': `\`\`\`json\n${answerJson}\n\`\`\``,
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
    }),
  );

  it.effect('restores the target after a failing test run', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const spawner = scriptedSpawner({
        [shellKey('npm ci')]: { exitCode: 0 },
        [tscKey(TSC, TEMP_TSCONFIG)]: { exitCode: 0, stdout: '' },
        [shellKey('npm test')]: { exitCode: 1 },
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(fs.read(TARGET)).toBe(ORIGINAL);
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: 'the tests fail in the sandbox before any change',
        environment: {
          stage: 'tests',
          diagnosis: { _tag: 'Unknown' },
          outputTail: '',
          command: 'npm test',
          exitCode: 1,
        },
      });
    }),
  );

  it.effect('skips typecheck for a JavaScript target', () =>
    Effect.gen(function* () {
      const jsAnswer = {
        ...answer,
        target: { file: 'src/f.js', symbol: 'f', text: ORIGINAL },
      };
      const fs = memoryFileSystem({
        'answer.json': JSON.stringify(jsAnswer),
        'src/f.js': ORIGINAL,
        ...projectConfigFile(),
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      const errors = yield* TestConsole.errorLines;
      expect(errors.some(line => String(line).includes('typecheck skipped'))).toBe(true);
    }),
  );

  it.effect('skips with a verdict when the answer file is missing', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({});
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Skipped');
      if (outcome._tag === 'Skipped') {
        expect(outcome.reason).toBe('the agent gave no answer');
      }
    }),
  );

  it.effect('rejects an invalid answer with a one-line reason', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({ 'answer.json': '{"nope":true}' });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Rejected');
      if (outcome._tag === 'Rejected') {
        expect(outcome.reason).toMatch(/^the answer is invalid: \S/);
        expect(outcome.reason).not.toContain('\n');
      }
    }),
  );

  it.effect("names only a round's faults in an answer that isn't a decline", () =>
    Effect.gen(function* () {
      const { reason: _, ...withoutReason } = answer;
      const fs = memoryFileSystem({ 'answer.json': JSON.stringify(withoutReason) });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome).toMatchObject({
        _tag: 'Rejected',
        reason: 'the answer is invalid: Missing key at ["reason"]',
      });
    }),
  );

  it.effect('rejects a principle id that is not lowercase kebab-case, naming the card', () =>
    Effect.gen(function* () {
      const badCard = {
        ...card('Optional Chaining', ORIGINAL),
        principle: { id: 'over-isSome', statement: 'Do it.' },
      };
      const fs = memoryFileSystem({
        'answer.json': JSON.stringify({
          ...answer,
          cards: [...cards.slice(0, 2), badCard, ...cards.slice(3)],
        }),
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, passingSpawner.layer)),
      );
      expect(outcome._tag).toBe('Rejected');
      if (outcome._tag === 'Rejected') {
        expect(outcome.error).toContain('["cards"][2]["principle"]["id"]');
        expect(outcome.error).not.toContain('declined');
      }
    }),
  );

  it.effect(
    'rejects the answer without running the tests when too few cards pass the typecheck',
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem(baseFiles);
        const failing = [1, 2, 3, 4].map(
          number =>
            `src/.codetinder-typecheck-card-${number}.ts(1,1): error TS2322: Type mismatch.`,
        );
        const commands: string[] = [];
        const spawner = scriptedSpawner(key => {
          commands.push(key);
          if (key === shellKey('npm ci')) return { exitCode: 0 };
          if (key === tscKey(TSC, TEMP_TSCONFIG)) {
            return { exitCode: 2, stdout: `${failing.join('\n')}\n` };
          }
          return undefined;
        });
        const outcome = yield* verifyRound('answer.json').pipe(
          Effect.provide(provideRound(fs.layer, spawner.layer)),
        );
        expect(outcome).toMatchObject({
          _tag: 'Rejected',
          reason: 'only 2 card(s) passed the typecheck, and a round needs 3',
        });
        if (outcome._tag === 'Rejected') {
          expect(outcome.error).toContain(
            'card 1 (Remove Redundant Addition):\nerror TS2322: Type mismatch.\n  at: function f() { return 1 + 0; }',
          );
          expect(outcome.error).toContain(
            'card 4 (Convert Function Declaration to Arrow Function):',
          );
        }
        expect(commands).not.toContain(shellKey('npm test'));
      }),
  );

  const declining = (declined: string) =>
    verifyRound('answer.json').pipe(
      Effect.provide(
        provideRound(
          memoryFileSystem({ 'answer.json': JSON.stringify({ declined }) }).layer,
          passingSpawner.layer,
        ),
      ),
    );

  it.effect("skips with the agent's reason as one trimmed line when it declines", () =>
    Effect.gen(function* () {
      const outcome = yield* declining('No function qualifies.\n\n  It only changes docs.  ');
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: 'No function qualifies. It only changes docs.',
      });
    }),
  );

  it.effect('keeps only the whole sentences of a long reason that fit', () =>
    Effect.gen(function* () {
      const outcome = yield* declining(
        `No function qualifies. ${'The rest of the diff is config, docs and tests. '.repeat(10)}`,
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: `No function qualifies.${' The rest of the diff is config, docs and tests.'.repeat(5)}`,
      });
    }),
  );

  it.effect('cuts a first sentence longer than the cap at a word, with an ellipsis', () =>
    Effect.gen(function* () {
      const outcome = yield* declining(
        `The diff changes ${'config, docs, tests, '.repeat(20)}only.`,
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: `The diff changes ${'config, docs, tests, '.repeat(13)}config…`,
      });
    }),
  );

  it.effect("skips with tsc's first line when tsc cannot check the sources", () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        'tsconfig.json': JSON.stringify({ compilerOptions: { emitDeclarationOnly: true } }),
      });
      const seenConfigs: string[] = [];
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === tscKey(TSC, TEMP_TSCONFIG)) {
          seenConfigs.push(fs.read(TEMP_TSCONFIG) ?? '');
          return {
            exitCode: 2,
            stdout: `${TEMP_TSCONFIG}(2,60): error TS5069: Option 'emitDeclarationOnly' cannot be specified.\n`,
          };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome).toEqual({
        _tag: 'Skipped',
        reason: `TypeScript couldn't check the picked function: ${TEMP_TSCONFIG}(2,60): error TS5069: Option 'emitDeclarationOnly' cannot be specified.`,
      });
      expect(JSON.parse(seenConfigs[0] ?? '{}').compilerOptions).toMatchObject({
        emitDeclarationOnly: false,
      });
    }),
  );

  it.effect('keeps the check going when tsc fails only in a project file of its own', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === shellKey('npm test')) return { exitCode: 0 };
        if (key === tscKey(TSC, TEMP_TSCONFIG)) {
          return { exitCode: 2, stdout: 'src/other.ts(1,1): error TS2322: Broken elsewhere.\n' };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
    }),
  );

  it.effect('checks against the referenced project that owns the function, not the root', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: './tsconfig.app.json' }],
        }),
        'tsconfig.app.json': JSON.stringify({
          compilerOptions: { strict: true, jsx: 'react-jsx' },
        }),
      });
      const seenConfigs: string[] = [];
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === shellKey('npm test')) return { exitCode: 0 };
        if (key === tscKey(TSC, 'tsconfig.json', '--showConfig')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              compilerOptions: {},
              references: [{ path: './tsconfig.app.json' }],
            }),
          };
        }
        if (key.endsWith('tsconfig.app.json --listFilesOnly')) {
          return { exitCode: 0, stdout: `${TARGET}\n` };
        }
        if (key === tscKey(TSC, TEMP_TSCONFIG)) {
          seenConfigs.push(fs.read(TEMP_TSCONFIG) ?? '');
          return { exitCode: 0, stdout: '' };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      expect(JSON.parse(seenConfigs[0] ?? '{}').extends).toMatch(/\/tsconfig\.app\.json$/);
    }),
  );

  it.effect('falls back to the nearest tsconfig when no reference includes the function', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...baseFiles,
        'tsconfig.json': JSON.stringify({
          files: [],
          references: [{ path: './tsconfig.app.json' }],
        }),
      });
      const seenConfigs: string[] = [];
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === shellKey('npm test')) return { exitCode: 0 };
        if (key === tscKey(TSC, 'tsconfig.json', '--showConfig')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ references: [{ path: './tsconfig.app.json' }] }),
          };
        }
        if (key === tscKey(TSC, TEMP_TSCONFIG)) {
          seenConfigs.push(fs.read(TEMP_TSCONFIG) ?? '');
          return { exitCode: 0, stdout: '' };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      expect(JSON.parse(seenConfigs[0] ?? '{}').extends).toMatch(/\/tsconfig\.json$/);
    }),
  );

  it.effect('typechecks against the project declarations, and not those in node_modules', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(baseFiles);
      const seenConfigs: string[] = [];
      const spawner = scriptedSpawner(key => {
        if (key === shellKey('npm ci')) return { exitCode: 0 };
        if (key === shellKey('npm test')) return { exitCode: 0 };
        if (key === tscKey(TSC, 'tsconfig.json', '--listFilesOnly')) {
          return {
            exitCode: 0,
            stdout: `${TARGET}\nsrc/vite-env.d.ts\nnode_modules/vite/client.d.ts\n`,
          };
        }
        if (key === tscKey(TSC, TEMP_TSCONFIG)) {
          seenConfigs.push(fs.read(TEMP_TSCONFIG) ?? '');
          return { exitCode: 0, stdout: '' };
        }
        return undefined;
      });
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      expect(JSON.parse(seenConfigs[0] ?? '{}').files).toEqual(
        expect.arrayContaining(['vite-env.d.ts']),
      );
      expect(JSON.parse(seenConfigs[0] ?? '{}').files).not.toEqual(
        expect.arrayContaining([expect.stringContaining('node_modules')]),
      );
    }),
  );
});

const STATUS = ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'].join(' ');
const MERGE_REQUEST_FILES = 'git diff --name-only -z origin/main...HEAD';
const checkoutKey = (path: string) => `git checkout HEAD -- ${path}`;

/** A learn run's repo after the rewrite: what `git status` lists, and what the MR changes. */
const rewriteSpawner = ({
  status = '',
  mergeRequestFiles = ['src/f.ts'],
  install = { exitCode: 0 },
  test = { exitCode: 0 },
  testResults = [],
}: {
  status?: string;
  mergeRequestFiles?: readonly string[];
  install?: ScriptedCommandResult;
  test?: ScriptedCommandResult;
  // The results of the first test runs, in order; `test` answers the runs after them.
  testResults?: readonly ScriptedCommandResult[];
} = {}) => {
  const ran: string[] = [];
  let testRuns = 0;
  const spawner = scriptedSpawner(key => {
    ran.push(key);
    if (key === STATUS) return { exitCode: 0, stdout: status };
    if (key === MERGE_REQUEST_FILES) {
      return { exitCode: 0, stdout: mergeRequestFiles.map(file => `${file}\0`).join('') };
    }
    if (key.startsWith('git checkout HEAD -- ')) return { exitCode: 0 };
    if (key === shellKey('npm ci')) return install;
    if (key === shellKey('npm test')) {
      testRuns += 1;
      return testResults[testRuns - 1] ?? test;
    }
    return undefined;
  });
  return { ran, layer: spawner.layer };
};

const provideRewrite = (
  fsLayer: Layer.Layer<FileSystem.FileSystem>,
  spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.provide(
    Layer.mergeAll(
      provideRound(fsLayer, spawnerLayer),
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          DUO_WORKFLOW_GOAL: '7',
          DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: MERGE_REQUEST_CONTEXT,
          DUO_WORKFLOW_PROJECT_ID: '87434709',
        }),
      ),
      Layer.succeed(
        GitLabMergeRequests,
        GitLabMergeRequests.of({
          ...noSandboxFixMergeRequests,
          get: () =>
            Effect.succeed({
              sourceBranch: 'feat/x',
              targetBranch: 'main',
              webUrl: 'https://gitlab.com/group/demo/-/merge_requests/7',
              isDraft: false,
              isOpen: true,
              sourceProjectId: 87434709,
              targetProjectId: 87434709,
            }),
          createMergeRequest: () => Effect.die('not used by this test'),
          createNote: () => Effect.succeed({ authorUsername: 'ai-codetinder-acme' }),
          finishReview: () => Effect.succeed(false),
          latestReviewRequest: () => Effect.die('not used by this test'),
          replyToNote: () => Effect.die('not used by this test'),
        }),
      ),
    ),
  );

const PRINCIPLES_DOC = '.codetinder/principles.md';

const statusOf = (...entries: string[]) => entries.map(entry => `${entry}\0`).join('');

describe('verifyRound and the freshness budget', () => {
  const cardOn = (principleId: string, after: string) => ({
    ...card(`Change for ${principleId}`, after),
    principle: { id: principleId, statement: `${principleId}.` },
  });
  const afterOf = (index: number) => `function f() { return ${index}; }`;
  const deckOn = (...principleIds: string[]) =>
    principleIds.map((principleId, index) => cardOn(principleId, afterOf(index)));
  const questions = (ages: Record<string, number | null>) =>
    Object.entries(ages).map(([id, roundsSinceJudged]) => ({
      id,
      statement: `${id}.`,
      supports: { likes: 0, dislikes: 0 },
      opposes: { likes: 0, dislikes: 0 },
      roundsSinceJudged,
    }));
  const filesFor = (principleIds: readonly string[], ages?: Record<string, number | null>) => ({
    ...baseFiles,
    'answer.json': JSON.stringify({ ...answer, cards: deckOn(...principleIds) }),
    ...(ages === undefined ? {} : { [QUESTIONS_SNAPSHOT_FILE]: JSON.stringify(questions(ages)) }),
  });
  /** Tests that pass or fail in the order they run, and the runs the spawner saw. */
  const spawnerFor = (testExitCodes: readonly number[] = []) => {
    const runs = { installs: 0, tests: 0 };
    const spawner = scriptedSpawner(key => {
      if (key === shellKey('npm ci')) {
        runs.installs += 1;
        return { exitCode: 0 };
      }
      if (key === tscKey(TSC, TEMP_TSCONFIG)) return { exitCode: 0, stdout: '' };
      if (key === shellKey('npm test')) {
        const exitCode = testExitCodes[runs.tests] ?? 0;
        runs.tests += 1;
        return { exitCode };
      }
      return undefined;
    });
    return { spawner, runs };
  };

  const AGES = { rested0: 0, rested1: 1, rested2: 2, eligible3: 3, lately: null };

  it.effect('drops the cards on the most recently judged resting questions first', () =>
    Effect.gen(function* () {
      // Two eligible cards allow two resting ones: of the four, the age-0 card goes, then the
      // later of the two age-1 cards.
      const ids = ['rested0', 'eligible3', 'rested1', 'brand-new', 'rested2', 'rested1'];
      const fs = memoryFileSystem(filesFor(ids, AGES));
      const { spawner, runs } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(runs.tests).toBe(6);
      expect(outcome._tag).toBe('Verified');
      if (outcome._tag === 'Verified') {
        expect(outcome.round.cards.map(c => c.principle.id)).toEqual([
          'eligible3',
          'rested1',
          'brand-new',
          'rested2',
        ]);
        expect(outcome.round.cards.map(c => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
        expect(outcome.eligibleCards).toBe(2);
      }
    }),
  );

  it.effect('rests a question at an age of 2 and no longer at an age of 3', () =>
    Effect.gen(function* () {
      const ids = ['rested2', 'eligible3', 'eligible3-too', 'rested2-too', 'brand-new'];
      const ages = { rested2: 2, 'rested2-too': 2, eligible3: 3, 'eligible3-too': 3 };
      const fs = memoryFileSystem(filesFor(ids, ages));
      const { spawner } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      // Three eligible cards and two resting: all five stay.
      expect(outcome._tag === 'Verified' && outcome.eligibleCards).toBe(3);

      const allRested = ['eligible3', 'eligible3-too', 'rested2', 'rested2-too'];
      const crowded = memoryFileSystem(filesFor(allRested, { ...ages, 'eligible3-too': 2 }));
      const crowdedOutcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(crowded.layer, spawner.layer)),
      );
      // Only one eligible card is left against three resting: too few remain.
      expect(crowdedOutcome._tag).toBe('Rejected');
    }),
  );

  it.effect('rejects, before the install, an answer with too few cards left, and says why', () =>
    Effect.gen(function* () {
      const ids = ['rested0', 'rested1', 'eligible3', 'rested2', 'rested0', 'brand-new-resting'];
      const fs = memoryFileSystem(filesFor(ids, { ...AGES, 'brand-new-resting': 1 }));
      const { spawner, runs } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(runs).toEqual({ installs: 0, tests: 0 });
      expect(outcome).toEqual({
        _tag: 'Rejected',
        reason:
          "only 2 card(s) are left once the questions judged in the project's last 3 judged rounds rest, and a round needs 3",
        error: expect.stringContaining('Cards remaining: 2'),
      });
      if (outcome._tag === 'Rejected') {
        expect(outcome.error).toContain('- Change for rested0: rested0, age 0, resting, removed');
        expect(outcome.error).toContain('- Change for eligible3: eligible3, age 3, eligible\n');
        expect(outcome.error).toContain('Removed ids: rested0, rested1');
        expect(outcome.error).toContain('New ids: none');
      }
    }),
  );

  it.effect('names the ids the agent minted when it rejects', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(filesFor(['new-one', 'rested0', 'rested1', 'new-two'], AGES));
      const { spawner } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      // Four cards fit the schema's range, two of them eligible and two resting: they all stay.
      expect(outcome._tag).toBe('Verified');
      const crowded = memoryFileSystem(
        filesFor(['new-one', 'rested0', 'rested1', 'rested2', 'rested0'], AGES),
      );
      const rejected = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(crowded.layer, spawner.layer)),
      );
      expect(rejected._tag === 'Rejected' && rejected.error).toContain('New ids: new-one');
    }),
  );

  it.effect('holds the cards that pass the tests to the budget', () =>
    Effect.gen(function* () {
      // Three eligible and three resting cards fit; then the tests drop two eligible ones.
      const ids = ['eligible3', 'brand-new', 'lately', 'rested0', 'rested1', 'rested2'];
      const fs = memoryFileSystem(filesFor(ids, AGES));
      const { spawner, runs } = spawnerFor([0, 1, 1, 0, 0, 0]);
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(runs.tests).toBe(6);
      expect(outcome).toEqual({
        _tag: 'Rejected',
        reason:
          "only 2 card(s) are left once the questions judged in the project's last 3 judged rounds rest, and a round needs 3",
        error: expect.stringContaining('Removed ids: rested0, rested1'),
      });
    }),
  );

  it.effect('gives a deck the tests leave short of fresh cards its correction, not a skip', () =>
    Effect.gen(function* () {
      // Trimmed before the tests, this deck would keep two eligible and two resting cards, lose
      // one of each to them, and be skipped with two. Tested whole, four pass: the budget then
      // leaves two, which the agent can correct.
      const ids = ['eligible3', 'rested0', 'brand-new', 'rested1', 'rested2', 'rested1-too'];
      const fs = memoryFileSystem(filesFor(ids, { ...AGES, 'rested1-too': 1 }));
      const { spawner, runs } = spawnerFor([1, 0, 0, 1, 0, 0]);
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(runs.tests).toBe(6);
      expect(outcome).toEqual({
        _tag: 'Rejected',
        reason:
          "only 2 card(s) are left once the questions judged in the project's last 3 judged rounds rest, and a round needs 3",
        error: expect.stringContaining('Cards remaining: 2'),
      });
    }),
  );

  it.effect('keeps what the budget leaves of the cards that pass the tests', () =>
    Effect.gen(function* () {
      const ids = ['eligible3', 'brand-new', 'lately', 'rested0', 'rested1', 'rested2'];
      const fs = memoryFileSystem(filesFor(ids, AGES));
      const { spawner } = spawnerFor([0, 0, 1, 0, 0, 0]);
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      // Five cards pass: two eligible, three resting, so the newest judged rests out.
      expect(outcome._tag).toBe('Verified');
      if (outcome._tag === 'Verified') {
        expect(outcome.round.cards.map(c => c.principle.id)).toEqual([
          'eligible3',
          'brand-new',
          'rested1',
          'rested2',
        ]);
        expect(outcome.eligibleCards).toBe(2);
      }
    }),
  );

  it.effect('takes every id as new, so all cards eligible, when the project has no questions', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(filesFor(['a', 'b', 'c', 'd'], {}));
      const { spawner } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag === 'Verified' && outcome.eligibleCards).toBe(4);
    }),
  );

  it.effect('holds a round to no budget and counts nothing when the questions were not read', () =>
    Effect.gen(function* () {
      // Every card is on one id, which would rest under any history that held it.
      const fs = memoryFileSystem(filesFor(['rested0', 'rested0', 'rested0', 'rested0']));
      const { spawner } = spawnerFor();
      const outcome = yield* verifyRound('answer.json').pipe(
        Effect.provide(provideRound(fs.layer, spawner.layer)),
      );
      expect(outcome._tag).toBe('Verified');
      expect(outcome).not.toHaveProperty('eligibleCards');
    }),
  );
});

describe('runVerifyRewrite', () => {
  it.effect('reverts what the rewrite may not change, and keeps the rest', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        'src/f.ts': 'rewritten',
        'src/stray.ts': 'created by the agent',
        [PRINCIPLES_DOC]: 'rendered',
        '.codetinder/task.md': 'the task',
        [REWRITE_RUN_FILES.rewriteAnswer]: '{}',
        [REWRITE_STATE_FILES.untrackedBefore]: '.bashrc\0',
      });
      const spawner = rewriteSpawner({
        mergeRequestFiles: ['src/f.ts', '.gitlab/duo/agent-config.yml'],
        status: statusOf(
          ' M src/f.ts',
          ' M package.json',
          ' M .gitlab/duo/agent-config.yml',
          '?? src/stray.ts',
          `?? ${PRINCIPLES_DOC}`,
          '?? .codetinder/task.md',
          `?? ${REWRITE_RUN_FILES.rewriteAnswer}`,
        ),
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));

      expect(spawner.ran.filter(key => key.startsWith('git checkout'))).toEqual([
        checkoutKey('package.json'),
        checkoutKey('.gitlab/duo/agent-config.yml'),
      ]);
      expect(fs.read('src/stray.ts')).toBeUndefined();
      expect(fs.read('src/f.ts')).toBe('rewritten');
      expect(fs.read(PRINCIPLES_DOC)).toBe('rendered');
      expect(fs.read('.codetinder/task.md')).toBe('the task');
      expect(fs.read(REWRITE_RUN_FILES.rewriteAnswer)).toBe('{}');
      expect(
        (yield* TestConsole.errorLines).filter(line => String(line).startsWith('reverted')),
      ).toEqual([
        "reverted package.json: outside the rewrite's scope",
        "reverted .gitlab/duo/agent-config.yml: outside the rewrite's scope",
        "reverted src/stray.ts: outside the rewrite's scope",
      ]);
      expect(yield* TestConsole.logLines).toEqual(['verified']);
    }),
  );

  it.effect('keeps the untracked files that were there before the rewrite', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        '.bashrc': 'the runner’s',
        '.vscode/settings.json': '{}',
        'src/stray.ts': 'created by the agent',
        [REWRITE_STATE_FILES.untrackedBefore]: '.bashrc\0.vscode/settings.json\0',
      });
      const spawner = rewriteSpawner({
        status: statusOf('?? .bashrc', '?? .vscode/settings.json', '?? src/stray.ts'),
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(fs.read('.bashrc')).toBe('the runner’s');
      expect(fs.read('.vscode/settings.json')).toBe('{}');
      expect(fs.read('src/stray.ts')).toBeUndefined();
      expect(yield* TestConsole.logLines).toEqual(['verified']);
    }),
  );

  it.effect('deletes no untracked file without the snapshot, and still restores tracked ones', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        '.bashrc': 'the runner’s',
        'src/stray.ts': 'created by the agent',
      });
      const spawner = rewriteSpawner({
        status: statusOf('?? .bashrc', '?? src/stray.ts', ' M package.json'),
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(fs.read('.bashrc')).toBe('the runner’s');
      expect(fs.read('src/stray.ts')).toBe('created by the agent');
      expect(spawner.ran).toContain(checkoutKey('package.json'));
      const errors = yield* TestConsole.errorLines;
      expect(
        errors.some(line => String(line).startsWith(`no ${REWRITE_STATE_FILES.untrackedBefore}`)),
      ).toBe(true);
      expect(yield* TestConsole.logLines).toEqual(['verified']);
    }),
  );

  it.effect('restores the config before reading it, and the rest only after', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const spawner = rewriteSpawner({
        status: statusOf(' M .codetinder/config.json', ' M package.json'),
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(spawner.ran.filter(key => key.startsWith('git ') && key !== STATUS)).toEqual([
        checkoutKey('.codetinder/config.json'),
        MERGE_REQUEST_FILES,
        checkoutKey('package.json'),
      ]);
    }),
  );

  it.effect('records the verdict and removes an earlier failed run’s output when verified', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        [REWRITE_STATE_FILES.verdict]: 'failed: tests failed\n',
        [REWRITE_STATE_FILES.testOutput]: 'FAIL src/f.test.ts\n',
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, rewriteSpawner().layer));
      expect(yield* TestConsole.logLines).toEqual(['verified']);
      expect(fs.read(REWRITE_STATE_FILES.verdict)).toBe('verified\n');
      expect(fs.read(REWRITE_STATE_FILES.testOutput)).toBeUndefined();
      expect(fs.read(REWRITE_STATE_FILES.testCommand)).toBe('npm test\n');
    }),
  );

  it.effect('records the verdict and the tests’ output when they fail', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const spawner = rewriteSpawner({
        test: { exitCode: 1, stdout: 'FAIL src/f.test.ts\n  expected 1, got 2\n' },
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(yield* TestConsole.logLines).toEqual(['failed: tests failed']);
      expect(fs.read(REWRITE_STATE_FILES.verdict)).toBe('failed: tests failed\n');
      expect(fs.read(REWRITE_STATE_FILES.testOutput)).toBe(
        'FAIL src/f.test.ts\n  expected 1, got 2\n',
      );
      expect(fs.read(REWRITE_STATE_FILES.testCommand)).toBeUndefined();
    }),
  );

  it.effect('records the install’s output and blames the sandbox when the install fails', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const output =
        'npm error 403 403 Forbidden - GET https://registry.npmjs.org/vitest - Forbidden';
      const spawner = rewriteSpawner({
        install: { exitCode: 1, stdout: `${output}\n` },
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(yield* TestConsole.logLines).toEqual([
        'failed: the install fails in the sandbox before any change',
      ]);
      expect(fs.read(REWRITE_STATE_FILES.testOutput)).toBe(`${output}\n`);
      expect(JSON.parse(fs.read(REWRITE_STATE_FILES.environment) ?? '')).toEqual({
        stage: 'install',
        diagnosis: { _tag: 'BlockedHosts', hosts: ['registry.npmjs.org'] },
        outputTail: output,
        command: 'npm ci',
        exitCode: 1,
      });
    }),
  );

  it.effect('does not check the tests on the merge request’s code before the retry', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const spawner = rewriteSpawner({
        status: statusOf(' M src/f.ts'),
        test: { exitCode: 1 },
      });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(yield* TestConsole.logLines).toEqual(['failed: tests failed']);
      expect(spawner.ran.filter(key => key === shellKey('npm test'))).toHaveLength(1);
      expect(fs.read(REWRITE_STATE_FILES.environment)).toBeUndefined();
    }),
  );

  it.effect(
    'blames the sandbox when the tests fail on the merge request’s code after the retry',
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem({
          ...projectConfigFile(),
          [REWRITE_RUN_FILES.retryAnswer]: '{}',
        });
        const spawner = rewriteSpawner({
          status: statusOf(' M src/f.ts'),
          test: { exitCode: 1, stdout: 'FAIL src/f.test.ts\nconnect ECONNREFUSED 10.0.0.5:5432\n' },
        });
        yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
        expect(yield* TestConsole.logLines).toEqual([
          'failed: the tests fail in the sandbox before any change',
        ]);
        // The rewrite is undone for the check: the tracked file goes back to the merge request's code.
        expect(spawner.ran).toContain(checkoutKey('src/f.ts'));
        expect(JSON.parse(fs.read(REWRITE_STATE_FILES.environment) ?? '')).toEqual({
          stage: 'tests',
          diagnosis: { _tag: 'BlockedHosts', hosts: ['10.0.0.5'] },
          outputTail: 'FAIL src/f.test.ts\nconnect ECONNREFUSED 10.0.0.5:5432',
          command: 'npm test',
          exitCode: 1,
        });
      }),
  );

  it.effect(
    'blames the rewrite when the tests pass on the merge request’s code after the retry',
    () =>
      Effect.gen(function* () {
        const fs = memoryFileSystem({
          ...projectConfigFile(),
          [REWRITE_RUN_FILES.retryAnswer]: '{}',
        });
        const spawner = rewriteSpawner({
          status: statusOf(' M src/f.ts'),
          testResults: [{ exitCode: 1 }, { exitCode: 0 }],
        });
        yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
        expect(yield* TestConsole.logLines).toEqual(['failed: tests failed']);
        expect(fs.read(REWRITE_STATE_FILES.environment)).toBeUndefined();
      }),
  );

  it.effect('hands on only the tail of a long test output', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`);
      const spawner = rewriteSpawner({ test: { exitCode: 1, stdout: `${lines.join('\n')}\n` } });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(fs.read(REWRITE_STATE_FILES.testOutput)).toBe(`${lines.slice(-200).join('\n')}\n`);
    }),
  );

  it.effect('fails the verdict when git cannot list the changes', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const spawner = scriptedSpawner({ [STATUS]: { exitCode: 128 } });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, spawner.layer));
      const verdict = `failed: can't check the rewrite's scope: ${STATUS} exited 128`;
      expect(yield* TestConsole.logLines).toEqual([verdict]);
      expect(fs.read(REWRITE_STATE_FILES.verdict)).toBe(`${verdict}\n`);
    }),
  );

  it.effect('prints failed when the config is invalid', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({ '.codetinder/config.json': '{"version":2}' });
      yield* runVerifyRewrite().pipe(provideRewrite(fs.layer, rewriteSpawner().layer));
      expect(yield* TestConsole.logLines).toEqual(['failed: invalid .codetinder/config.json']);
    }),
  );
});

describe('runVerifySweep', () => {
  const picks = {
    [SWEEP_STATE_FILES.picks]: JSON.stringify({
      kept: [
        { file: 'src/cart.ts', name: 'total', principleIds: ['early-returns'], why: 'It nests.' },
      ],
      left: [],
    }),
  };

  it.effect("reverts all but the kept functions' files, the principles doc included", () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        ...picks,
        'src/cart.ts': 'rewritten',
        [PRINCIPLES_DOC]: 'edited by the agent',
        [SWEEP_RUN_FILES.answer]: '{}',
        [REWRITE_STATE_FILES.untrackedBefore]: '',
      });
      const spawner = rewriteSpawner({
        status: statusOf(
          ' M src/cart.ts',
          ' M src/other.ts',
          ' M src/cart.test.ts',
          ` M ${PRINCIPLES_DOC}`,
          `?? ${SWEEP_RUN_FILES.answer}`,
        ),
      });
      yield* runVerifySweep().pipe(provideRewrite(fs.layer, spawner.layer));

      expect(yield* TestConsole.logLines).toEqual(['verified']);
      expect(spawner.ran.filter(key => key.startsWith('git checkout'))).toEqual([
        checkoutKey('src/other.ts'),
        checkoutKey('src/cart.test.ts'),
        checkoutKey(PRINCIPLES_DOC),
      ]);
      // A sweep's scope is its picks: it never asks for a merge request's changes.
      expect(spawner.ran).not.toContain(MERGE_REQUEST_FILES);
      expect(fs.read(SWEEP_RUN_FILES.answer)).toBe('{}');
      expect(fs.read(REWRITE_STATE_FILES.verdict)).toBe('verified\n');
    }),
  );

  it.effect('checks the tests without the rewrite after the retry, and blames the sandbox', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem({
        ...projectConfigFile(),
        ...picks,
        [REWRITE_RUN_FILES.retryAnswer]: '{}',
      });
      const spawner = rewriteSpawner({
        status: statusOf(' M src/cart.ts'),
        test: { exitCode: 1, stdout: 'FAIL' },
      });
      yield* runVerifySweep().pipe(provideRewrite(fs.layer, spawner.layer));
      expect(yield* TestConsole.logLines).toEqual([
        'failed: the tests fail in the sandbox before any change',
      ]);
      expect(spawner.ran).toContain(checkoutKey('src/cart.ts'));
    }),
  );

  it.effect('fails the verdict without the picks', () =>
    Effect.gen(function* () {
      const fs = memoryFileSystem(projectConfigFile());
      const spawner = rewriteSpawner({ status: statusOf(' M src/cart.ts') });
      yield* runVerifySweep().pipe(provideRewrite(fs.layer, spawner.layer));
      expect((yield* TestConsole.logLines)[0]).toMatch(/^failed: the run has no sweep picks/);
    }),
  );
});
