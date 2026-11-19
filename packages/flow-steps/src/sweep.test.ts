import {
  CORRECTION_STATE_FILE,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  renderPrinciplesDoc,
  SWEEP_FUNCTION_LIMIT,
  SWEEP_RUN_FILES,
  SWEEP_STATE_FILES,
  type SweepFinding,
} from '@codetinder/core';
import { GitLabCommits, GitLabMergeRequests, GitLabSweeps } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestConsole from 'effect/testing/TestConsole';
import { CLAIM_FILE } from './claim';
import { CodeTinder } from './codetinder';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { type ScriptedCommandResult, scriptedSpawner } from './scripted-spawner';
import { runSweepPick, runSweepPropose } from './sweep';
import { TASK_FILE } from './task';

const PROJECT_ID = '87434709';
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const BASE_SHA = 'b2'.padEnd(40, '0');
const RUN_ID = '0b5d6c1e-8f61-4c3a-9a35-2f8e3c4f5a6b';
const JSON_HEADERS = { 'content-type': 'application/json' };

const DOC = {
  '.codetinder/principles.md': renderPrinciplesDoc([
    { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
  ]),
};

const finding = (name: string, file = 'src/cart.ts'): SweepFinding => ({
  file,
  name,
  principleIds: ['early-returns'],
  why: `${name} nests its happy path.`,
});

const CART = 'export function total() {}\nexport function subtotal() {}\n';

/** Runs `effect` over a checkout of `files`, git answering `git`, and GitLab and codetinder.dev. */
const runOn = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | CodeTinder
    | GitLabSweeps
    | GitLabCommits
    | GitLabMergeRequests
    | import('effect/FileSystem').FileSystem
    | Path.Path
    | import('effect/process/ChildProcessSpawner').ChildProcessSpawner
    | Stdio.Stdio
  >,
  {
    files,
    git = {},
    finish = 204,
    reclaim = 'Claimed',
  }: {
    readonly files: Record<string, string>;
    readonly git?: Record<string, ScriptedCommandResult>;
    /** What codetinder.dev answers the finish. */
    readonly finish?: number;
    /** What codetinder.dev answers the run asking for its claim again before it commits. */
    readonly reclaim?: 'Claimed' | 'Busy';
  },
) => {
  const calls: { readonly route: string; readonly body: unknown }[] = [];
  const answer = (body: unknown, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: JSON_HEADERS });
  const fetch = scriptedFetch(async request => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.host}${url.pathname}`;
    calls.push({ route, body: request.method === 'GET' ? undefined : await request.json() });
    switch (route) {
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/finish`:
        return finish === 204
          ? answer(null, 204)
          : answer({ _tag: 'NotClaimOwner', message: 'not yours' }, finish);
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/claim`:
        return answer({ _tag: reclaim });
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/stop`:
        return answer(null, 204);
      case `GET gitlab.com/api/v4/projects/${PROJECT_ID}`:
        return answer({ default_branch: 'main', web_url: 'https://gitlab.com/acme/app' });
      case `POST gitlab.com/api/v4/projects/${PROJECT_ID}/repository/commits`:
        return answer({ id: 'd00d', web_url: 'https://gitlab.com/acme/app/-/commit/d00d' }, 201);
      case `POST gitlab.com/api/v4/projects/${PROJECT_ID}/merge_requests`:
        return answer({ iid: 31, web_url: 'https://gitlab.com/acme/app/-/merge_requests/31' }, 201);
      default:
        throw new Error(`unexpected request: ${route}`);
    }
  });
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DUO_WORKFLOW_PROJECT_ID: PROJECT_ID,
      GITLAB_TOKEN: 'test-gitlab-token',
      CODETINDER_ID_TOKEN: 'test-id-token',
    }),
  );
  const fs = memoryFileSystem(files);
  const services = Layer.mergeAll(
    CodeTinder.layer,
    GitLabSweeps.layer,
    GitLabCommits.layer,
    GitLabMergeRequests.layer,
  ).pipe(Layer.provide(withScriptedFetch(fetch)), Layer.provide(config));
  const env = Layer.mergeAll(
    TestConsole.layer,
    scriptedSpawner(git).layer,
    Stdio.layerTest({}),
    fs.layer,
    Path.layer,
    config,
    services,
  );
  return Effect.gen(function* () {
    yield* effect;
    return {
      printed: yield* TestConsole.logLines,
      logged: (yield* TestConsole.errorLines).join('\n'),
      calls,
      fs,
    };
  }).pipe(Effect.provide(env));
};

const SWEEP_RUN = {
  [SWEEP_STATE_FILES.sweep]: JSON.stringify({
    base: BASE_SHA,
    carryOver: [{ file: 'src/tax.ts', name: 'rate' }],
  }),
};

const NAMES_KEY = `git -c core.quotePath=false diff --no-renames --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ --name-only -z ${BASE_SHA} HEAD`;

describe('runSweepPick', () => {
  const pickFrom = (
    answer: string | undefined,
    files: Record<string, string> = {},
    { canCorrect = false }: { readonly canCorrect?: boolean } = {},
  ) =>
    runOn(runSweepPick(SWEEP_RUN_FILES.answer, { canCorrect }), {
      files: {
        ...DOC,
        ...SWEEP_RUN,
        [TASK_FILE]: '# Sweep the changed code\n',
        'src/cart.ts': CART,
        'src/tax.ts': 'export const rate = () => 1;\n',
        ...(answer === undefined ? {} : { [SWEEP_RUN_FILES.answer]: answer }),
        ...files,
      },
      git: { [NAMES_KEY]: { exitCode: 0, stdout: 'src/cart.ts\0README.md\0' } },
    });
  type Picked = { readonly fs: { read: (path: string) => string | undefined } };
  const picksOf = (result: Picked) => JSON.parse(result.fs.read(SWEEP_STATE_FILES.picks) ?? 'null');
  const stopOf = (result: Picked) => JSON.parse(result.fs.read(SWEEP_STATE_FILES.stop) ?? 'null');
  const correctionOf = (result: Picked) =>
    JSON.parse(result.fs.read(CORRECTION_STATE_FILE) ?? 'null');

  it.effect('keeps the functions found in the changed code and the carry-over', () =>
    Effect.gen(function* () {
      const answer = {
        functions: [
          finding('total'),
          finding('rate', 'src/tax.ts'),
          finding('gone', 'src/cart.ts'),
          finding('total', 'src/untouched.ts'),
        ],
      };
      const result = yield* pickFrom(
        JSON.stringify(answer),
        { 'src/untouched.ts': 'function total() {}' },
        { canCorrect: true },
      );
      expect(result.printed).toEqual(['picked']);
      expect(picksOf(result)).toEqual({
        kept: [finding('total'), finding('rate', 'src/tax.ts')],
        left: [],
      });
      expect(result.logged).toContain('- `gone` in `src/cart.ts`: `src/cart.ts` has no function');
    }),
  );

  it.effect(`leaves all but the first ${SWEEP_FUNCTION_LIMIT} for the next sweep`, () =>
    Effect.gen(function* () {
      const names = Array.from({ length: SWEEP_FUNCTION_LIMIT + 1 }, (_, index) => `f${index}`);
      const result = yield* pickFrom(
        JSON.stringify({ functions: names.map(name => finding(name)) }),
        { 'src/cart.ts': names.map(name => `function ${name}() {}`).join('\n') },
      );
      expect(picksOf(result).kept).toHaveLength(SWEEP_FUNCTION_LIMIT);
      expect(picksOf(result).left).toEqual([
        { file: 'src/cart.ts', name: `f${SWEEP_FUNCTION_LIMIT}` },
      ]);
    }),
  );

  it.effect('is clean when the agent found nothing', () =>
    Effect.gen(function* () {
      const result = yield* pickFrom(JSON.stringify({ functions: [] }), {}, { canCorrect: true });
      expect(result.printed).toEqual(['clean']);
      expect(picksOf(result)).toEqual({ kept: [], left: [] });
    }),
  );

  it.effect('fails on no answer, with no correction', () =>
    Effect.gen(function* () {
      const missing = yield* pickFrom(undefined, {}, { canCorrect: true });
      expect(missing.printed).toEqual(['failed: the agent gave no answer']);
      expect(missing.fs.read(SWEEP_STATE_FILES.picks)).toBeUndefined();
      expect(stopOf(missing)).toEqual({ cause: 'Answer', reason: 'the agent gave no answer' });
    }),
  );

  it.effect('hands an answer that does not parse over for its correction', () =>
    Effect.gen(function* () {
      const answer = '{"functions":[{"file":"src/cart.ts"}},{"file":"src/tax.ts"}]}';
      const result = yield* pickFrom(answer, {}, { canCorrect: true });
      expect(result.printed).toEqual(['correct']);
      expect(result.logged).toMatch(/the agent corrects its answer once: the answer is invalid: /);
      expect(correctionOf(result)).toMatchObject({
        task: '# Sweep the changed code\n',
        answer,
        error: expect.stringMatching(/JSON/),
      });
      expect(result.fs.read(SWEEP_STATE_FILES.picks)).toBeUndefined();
      expect(result.fs.read(SWEEP_STATE_FILES.stop)).toBeUndefined();
    }),
  );

  it.effect('hands an answer whose every function is out of reach over for its correction', () =>
    Effect.gen(function* () {
      const answer = JSON.stringify({
        functions: [finding('gone'), { ...finding('total'), principleIds: ['made-up'] }],
      });
      const result = yield* pickFrom(answer, {}, { canCorrect: true });
      expect(result.printed).toEqual(['correct']);
      expect(correctionOf(result).error).toBe(
        [
          '- `gone` in `src/cart.ts`: `src/cart.ts` has no function `gone`',
          '- `total` in `src/cart.ts`: none of its principles (`made-up`) is in the principles doc',
        ].join('\n'),
      );
    }),
  );

  it.effect('fails on an answer it rejects without the flag, keeping why for the proposal', () =>
    Effect.gen(function* () {
      const invalid = yield* pickFrom('{"functions": [{"file": "src/cart.ts"}]}');
      expect(invalid.printed[0]).toMatch(/^failed: the answer is invalid: /);
      expect(stopOf(invalid)).toMatchObject({ cause: 'Answer' });
      expect(invalid.fs.read(CORRECTION_STATE_FILE)).toBeUndefined();
    }),
  );

  it.effect('fails without the flag when every function is out of reach', () =>
    Effect.gen(function* () {
      const outOfReach = yield* pickFrom(JSON.stringify({ functions: [finding('gone')] }));
      expect(outOfReach.printed).toEqual([
        'failed: none of the 1 functions found is one the sweep can take on',
      ]);
      expect(stopOf(outOfReach)).toMatchObject({ cause: 'Answer' });
    }),
  );
});

const STATUS_KEY = 'git status --porcelain=v1 -z --untracked-files=all';

describe('runSweepPropose', () => {
  const proposeWith = ({
    picks,
    stop,
    environment = false,
    verdict = 'verified' as string | null,
    status = ' M src/cart.ts\0 M src/cart.test.ts\0?? .codetinder/task.md\0',
    finish,
    reclaim,
  }: {
    readonly picks?: { readonly kept: readonly SweepFinding[]; readonly left: readonly unknown[] };
    /** What `sweep pick` kept when it couldn't use the answer. */
    readonly stop?: { readonly cause: string; readonly reason: string };
    /** Whether `verify sweep` blamed the sandbox. */
    readonly environment?: boolean;
    readonly verdict?: string | null;
    readonly status?: string;
    readonly finish?: number;
    readonly reclaim?: 'Claimed' | 'Busy';
  }) =>
    runOn(runSweepPropose(), {
      files: {
        ...projectConfigFile({ tone: 'plain' }),
        ...DOC,
        [CLAIM_FILE]: JSON.stringify({ headSha: HEAD_SHA, runId: RUN_ID }),
        ...(picks === undefined ? {} : { [SWEEP_STATE_FILES.picks]: JSON.stringify(picks) }),
        ...(stop === undefined ? {} : { [SWEEP_STATE_FILES.stop]: JSON.stringify(stop) }),
        ...(environment ? { [REWRITE_STATE_FILES.environment]: '{}' } : {}),
        ...(verdict === null ? {} : { [REWRITE_STATE_FILES.verdict]: `${verdict}\n` }),
        'src/cart.ts': 'rewritten cart',
        'src/cart.test.ts': 'loosened test',
        [TASK_FILE]: 'task',
        [SWEEP_RUN_FILES.answer]: '{}',
        [REWRITE_RUN_FILES.rewriteAnswer]: '{}',
      },
      git: { [STATUS_KEY]: { exitCode: 0, stdout: status } },
      ...(finish === undefined ? {} : { finish }),
      ...(reclaim === undefined ? {} : { reclaim }),
    });
  const callsTo = (
    result: { readonly calls: readonly { route: string; body: unknown }[] },
    path: string,
  ) => result.calls.filter(({ route }) => route.endsWith(path)).map(({ body }) => body);
  const LEFT = [{ file: 'src/fee.ts', name: 'fee' }];

  it.effect('commits the rewrite on a branch of its own, opens its MR and finishes the sweep', () =>
    Effect.gen(function* () {
      const kept = [finding('total'), finding('rate', 'src/tax.ts')];
      const result = yield* proposeWith({ picks: { kept, left: LEFT } });
      expect(result.printed).toEqual(['proposed !31']);
      expect(callsTo(result, '/repository/commits')).toEqual([
        {
          branch: 'codetinder/sweep-1970-01-01-000000',
          start_sha: HEAD_SHA,
          commit_message:
            'style: bring 1 function in line with the coding principles\n\n- src/cart.ts: total (early-returns)',
          actions: [{ action: 'update', file_path: 'src/cart.ts', content: 'rewritten cart' }],
        },
      ]);
      const [mergeRequest] = callsTo(result, '/merge_requests') as {
        source_branch: string;
        target_branch: string;
        title: string;
        description: string;
      }[];
      expect(mergeRequest).toMatchObject({
        source_branch: 'codetinder/sweep-1970-01-01-000000',
        target_branch: 'main',
        title: 'CodeTinder sweep: 1 function brought in line with your principles',
      });
      expect(mergeRequest?.description).toContain(
        '[your coding principles](https://gitlab.com/acme/app/-/blob/main/.codetinder/principles.md)',
      );
      expect(mergeRequest?.description).toContain('- `total` in `src/cart.ts`: total nests');
      expect(mergeRequest?.description).toContain('  - `early-returns`: Return early.');
      expect(mergeRequest?.description).not.toContain('`rate`');
      expect(mergeRequest?.description).toContain('2 functions more left for the next sweep.');
      expect(callsTo(result, '/finish')).toEqual([
        {
          runId: RUN_ID,
          headSha: HEAD_SHA,
          outcome: { _tag: 'Proposed', mergeRequestIid: 31 },
          // The pick the rewrite didn't reach goes first: it was judged worse.
          carryOver: [{ file: 'src/tax.ts', name: 'rate' }, ...LEFT],
        },
      ]);
      expect(result.fs.paths()).not.toContain(TASK_FILE);
      expect(result.fs.paths()).not.toContain(SWEEP_RUN_FILES.answer);
    }),
  );

  it.effect('finishes a clean sweep when nothing was picked', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({ picks: { kept: [], left: [] } });
      expect(result.printed).toEqual(['clean']);
      expect(callsTo(result, '/finish')).toEqual([
        { runId: RUN_ID, headSha: HEAD_SHA, outcome: { _tag: 'Clean' }, carryOver: [] },
      ]);
      expect(callsTo(result, '/merge_requests')).toEqual([]);
    }),
  );

  it.effect('finishes a clean sweep when the rewrite changed none of its files', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: LEFT },
        status: ' M src/cart.test.ts\0',
      });
      expect(result.printed).toEqual(['clean']);
      expect(callsTo(result, '/finish')).toEqual([
        {
          runId: RUN_ID,
          headSha: HEAD_SHA,
          outcome: { _tag: 'Clean' },
          carryOver: [{ file: 'src/cart.ts', name: 'total' }, ...LEFT],
        },
      ]);
    }),
  );

  it.effect('records the sweep stopped when the tests failed on the rewrite', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: [] },
        verdict: 'failed: tests failed',
      });
      expect(result.printed).toEqual(['stopped: tests failed']);
      expect(result.logged).toContain('sweep stopped: tests failed');
      expect(callsTo(result, '/stop')).toEqual([{ runId: RUN_ID, cause: 'Tests' }]);
      expect(callsTo(result, '/finish')).toEqual([]);
      expect(callsTo(result, '/merge_requests')).toEqual([]);
    }),
  );

  it.effect('blames the sandbox when the install or tests fail before any change', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: [] },
        verdict: 'failed: the install fails in the sandbox before any change',
        environment: true,
      });
      expect(callsTo(result, '/stop')).toEqual([{ runId: RUN_ID, cause: 'Sandbox' }]);
    }),
  );

  it.effect("records the sweep stopped when the rewrite didn't run", () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: [] },
        verdict: null,
      });
      expect(result.printed).toEqual(["stopped: the rewrite didn't run"]);
      expect(callsTo(result, '/stop')).toEqual([{ runId: RUN_ID, cause: 'Error' }]);
    }),
  );

  it.effect('records the sweep stopped on an answer the pick could not use, saying why', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        stop: { cause: 'Answer', reason: 'the answer is invalid: Expected a valid JSON string' },
      });
      expect(result.printed).toEqual([
        'stopped: the answer is invalid: Expected a valid JSON string',
      ]);
      expect(callsTo(result, '/stop')).toEqual([{ runId: RUN_ID, cause: 'Answer' }]);
    }),
  );

  it.effect('records the sweep stopped when nothing was picked at all', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({});
      expect(result.printed).toEqual(["stopped: the sweep's task or its pick didn't run"]);
      expect(callsTo(result, '/stop')).toEqual([{ runId: RUN_ID, cause: 'Error' }]);
    }),
  );

  it.effect('logs a finish codetinder.dev refuses, the MR already open', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: [] },
        finish: 409,
      });
      expect(result.printed).toEqual(['proposed !31']);
      expect(result.logged).toContain("couldn't finish the sweep on codetinder.dev: not yours");
    }),
  );

  it.effect('publishes nothing, and leaves the claim alone, once another run took it over', () =>
    Effect.gen(function* () {
      const result = yield* proposeWith({
        picks: { kept: [finding('total')], left: [] },
        reclaim: 'Busy',
      });
      expect(result.printed).toEqual(['stopped: another run took the sweep over']);
      expect(result.logged).toContain('another run took the sweep over before it was proposed');
      expect(callsTo(result, '/claim')).toEqual([{ headSha: HEAD_SHA, runId: RUN_ID }]);
      expect(callsTo(result, '/repository/commits')).toEqual([]);
      expect(callsTo(result, '/merge_requests')).toEqual([]);
      expect(callsTo(result, '/finish')).toEqual([]);
      expect(callsTo(result, '/stop')).toEqual([]);
    }),
  );
});
