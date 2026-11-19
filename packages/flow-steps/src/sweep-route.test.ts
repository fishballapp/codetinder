import { renderPrinciplesDoc, SWEEP_STATE_FILES } from '@codetinder/core';
import { GitLabMergeRequests, GitLabSweeps } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Path from 'effect/Path';
import * as Stdio from 'effect/Stdio';
import * as TestConsole from 'effect/testing/TestConsole';
import { CLAIM_FILE } from './claim';
import { memoryFileSystem } from './memory-file-system';
import { projectConfigFile } from './project-config-fixture';
import { runRoute } from './route';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';
import { scriptedSpawner } from './scripted-spawner';
import { triggerContext } from './trigger-context-fixture';

const PROJECT_ID = '87434709';
const HEAD_SHA = 'c0ffee'.padEnd(40, '0');
const LAST_SHA = 'a1'.padEnd(40, '0');
const WALKED_SHA = 'b2'.padEnd(40, '0');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JSON_HEADERS = { 'content-type': 'application/json' };

const PRINCIPLES = {
  '.codetinder/principles.md': renderPrinciplesDoc([
    { id: 'early-returns', section: 'General', strength: 'strong', statement: 'Return early.' },
  ]),
};

const EMPTY_DOC = { '.codetinder/principles.md': renderPrinciplesDoc([]) };

const LAST_SWEEP = {
  sha: LAST_SHA,
  at: '2026-10-01T10:00:00.000Z',
  outcome: { _tag: 'Clean' },
};

const DIFF =
  'git -c core.quotePath=false diff --no-renames --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/';
const diffKey = (base: string, ...flags: string[]) => [DIFF, ...flags, base, 'HEAD'].join(' ');
const LOG =
  'git log --first-parent --diff-merges=first-parent --no-renames --numstat -z --format=commit %P --max-count=100';

/** A pipeline on `branch` with no merge request, as the run's context names it. */
const pipelineContext = ({
  branch = 'main',
  source = 'push',
  primaryBranch = 'main' as string | null,
} = {}) =>
  triggerContext('pipeline_hooks', {
    pipeline: { source_branch: branch, source },
    merge_request: { url: '' },
    agent_platform_standard_context:
      primaryBranch === null ? {} : { primary_branch: primaryBranch },
  });

/**
 * Runs the route on a pipeline on the default branch and returns what it printed, logged and asked
 * of codetinder.dev, and what it left for the sweep's later steps.
 */
const runSweepRoute = (args: {
  readonly context?: string;
  /** codetinder.dev's sweep state, over the defaults: threshold 100, no last sweep. */
  readonly state?: Record<string, unknown>;
  /** What codetinder.dev answers the claim. */
  readonly claim?: { readonly _tag: 'Claimed' | 'Busy' };
  /**
   * The first-parent log a first sweep walks, by the commit each page starts from: by default, one
   * commit adding 500 lines of code on `WALKED_SHA`.
   */
  readonly log?: Record<string, string>;
  /** The source branches of the project's open MRs. */
  readonly openBranches?: readonly string[];
  /** Lines added to `src/cart.ts` since the base. */
  readonly addedLines?: number;
  /** Whether the checkout has the base; `fetched` once a fetch brings it. */
  readonly base?: 'present' | 'fetched' | 'unfetchable';
  readonly files?: Record<string, string>;
  readonly hasIdToken?: boolean;
}) => {
  const requests: string[] = [];
  const claims: unknown[] = [];
  const finished: unknown[] = [];
  const ended: unknown[] = [];
  const answer = (body: unknown, status = 200) =>
    new Response(body === null ? null : JSON.stringify(body), { status, headers: JSON_HEADERS });
  const fetch = scriptedFetch(async request => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.host}${url.pathname}`;
    const state = url.searchParams.get('state');
    requests.push(state === null ? route : `${route}?state=${state}`);
    switch (route) {
      case `GET codetinder.dev/api/sweeps/${PROJECT_ID}`:
        return answer({
          threshold: 100,
          last: null,
          stopped: null,
          carryOver: [],
          isRunning: false,
          ...args.state,
        });
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/claim`:
        claims.push(await request.json());
        return answer(args.claim ?? { _tag: 'Claimed' });
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/end`:
        ended.push(await request.json());
        return answer(null, 204);
      case `POST codetinder.dev/api/sweeps/${PROJECT_ID}/finish`:
        finished.push(await request.json());
        return answer(null, 204);
      case `GET gitlab.com/api/v4/projects/${PROJECT_ID}`:
        return answer({ default_branch: 'main', web_url: 'https://gitlab.com/acme/app' });
      case `GET gitlab.com/api/v4/projects/${PROJECT_ID}/merge_requests`: {
        return answer(
          (args.openBranches ?? []).map((branch, index) => ({
            iid: index + 10,
            source_branch: branch,
            source_project_id: Number(PROJECT_ID),
          })),
        );
      }
      default:
        throw new Error(`unexpected request: ${route}`);
    }
  });
  const config = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      DUO_WORKFLOW_GOAL: JSON.stringify({ object_attributes: { ref: 'main', sha: HEAD_SHA } }),
      DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT: args.context ?? pipelineContext(),
      DUO_WORKFLOW_PROJECT_ID: PROJECT_ID,
      GITLAB_TOKEN: 'test-gitlab-token',
      ...(args.hasIdToken === false ? {} : { CODETINDER_ID_TOKEN: 'test-id-token' }),
    }),
  );
  const git: string[] = [];
  let isBaseFetched = false;
  const spawner = scriptedSpawner(key => {
    git.push(key);
    if (key === 'git rev-parse HEAD') return { exitCode: 0, stdout: `${HEAD_SHA}\n` };
    if (key.startsWith('git cat-file -e ')) {
      const base = args.base ?? 'present';
      return { exitCode: base === 'present' || (base === 'fetched' && isBaseFetched) ? 0 : 1 };
    }
    if (key.startsWith('git fetch --quiet --no-tags origin ')) {
      isBaseFetched = args.base === 'fetched';
      return { exitCode: isBaseFetched ? 0 : 128 };
    }
    if (key.startsWith(`${LOG} `)) {
      const log = args.log ?? { HEAD: `commit ${WALKED_SHA}\x00\n500\t0\tsrc/cart.ts\x00` };
      return { exitCode: 0, stdout: log[key.slice(LOG.length + 1)] ?? '' };
    }
    if (key.startsWith(`${DIFF} --numstat -z `)) {
      const added = args.addedLines ?? 500;
      return { exitCode: 0, stdout: `${added}\t1\tsrc/cart.ts\x00900\t0\tpnpm-lock.yaml\x00` };
    }
    return undefined;
  });
  const fs = memoryFileSystem(args.files ?? { ...projectConfigFile(), ...PRINCIPLES });
  const env = Layer.mergeAll(
    TestConsole.layer,
    spawner.layer,
    Stdio.layerTest({}),
    fs.layer,
    Path.layer,
    config,
    withScriptedFetch(fetch),
    Layer.mergeAll(GitLabMergeRequests.layer, GitLabSweeps.layer).pipe(
      Layer.provide(withScriptedFetch(fetch)),
      Layer.provide(config),
    ),
  );
  return Effect.gen(function* () {
    yield* runRoute();
    const read = (file: string) => {
      const text = fs.read(file);
      return text === undefined ? undefined : JSON.parse(text);
    };
    return {
      printed: yield* TestConsole.logLines,
      logged: (yield* TestConsole.errorLines).join('\n'),
      requests,
      claims,
      finished,
      ended,
      git,
      runClaim: read(CLAIM_FILE),
      sweep: read(SWEEP_STATE_FILES.sweep),
    };
  }).pipe(Effect.provide(env));
};

describe('runRoute on the default branch', () => {
  it.effect('sweeps once the code added since the last sweep reaches the threshold', () =>
    Effect.gen(function* () {
      const carryOver = [{ file: 'src/tax.ts', name: 'rate' }];
      const result = yield* runSweepRoute({ state: { last: LAST_SWEEP, carryOver } });
      expect(result).toMatchObject({
        printed: ['sweep'],
        claims: [{ headSha: HEAD_SHA, runId: expect.stringMatching(UUID) }],
        finished: [],
        sweep: { base: LAST_SHA, carryOver },
      });
      expect(result.runClaim).toEqual(result.claims[0]);
      expect(result.git).toContain(diffKey(LAST_SHA, '--numstat', '-z'));
      // The last sweep's commit is the base: there is no walk back.
      expect(result.git).not.toContain(`${LOG} HEAD`);
    }),
  );

  it.effect('takes the latest lines up to the threshold for the first sweep', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({});
      expect(result).toMatchObject({ printed: ['sweep'], sweep: { base: WALKED_SHA } });
      expect(result.git).toContain(`${LOG} HEAD`);
      // The walk counted the lines: no diff from the base, and no commit to fetch.
      expect(
        result.git.filter(key => key.startsWith(DIFF) || key.startsWith('git cat-file')),
      ).toEqual([]);
    }),
  );

  it.effect('walks back a page at a time to the threshold for the first sweep', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        log: {
          HEAD: 'commit p1\x00\n60\t0\tsrc/a.ts\x00commit p2\x00\n900\t0\tREADME.md\x00',
          p2: `commit ${WALKED_SHA}\x00\n40\t0\tsrc/b.ts\x00`,
        },
      });
      expect(result).toMatchObject({ printed: ['sweep'], sweep: { base: WALKED_SHA } });
      expect(result.git).toContain(`${LOG} p2`);
    }),
  );

  it.effect('waits while the whole history is short of the threshold', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        log: { HEAD: 'commit p1\x00\n60\t0\tsrc/a.ts\x00commit \x00\n30\t0\tsrc/b.ts\x00' },
      });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        ended: [{ runId: result.runClaim.runId }],
        sweep: undefined,
      });
      expect(result.logged).toContain('90 lines of code added, short of the threshold 100');
    }),
  );

  it.effect('sweeps the whole history when asked and it is short of the threshold', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ source: 'api' }),
        log: { HEAD: 'commit \x00\n30\t0\tsrc/a.ts\x00' },
      });
      expect(result).toMatchObject({ printed: ['sweep'], sweep: { base: null } });
    }),
  );

  it.effect('waits while the code added is short of the threshold', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ state: { last: LAST_SWEEP }, addedLines: 99 });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        claims: [{ runId: result.runClaim.runId }],
        ended: [{ runId: result.runClaim.runId }],
        finished: [],
        sweep: undefined,
      });
      expect(result.logged).toContain('99 lines of code added, short of the threshold 100');
    }),
  );

  it.effect('sweeps whatever the count when a developer asked for it', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ source: 'api' }),
        state: { last: LAST_SWEEP },
        addedLines: 3,
      });
      expect(result.printed).toEqual(['sweep']);
    }),
  );

  it.effect('stops when asked with no code added since and none left over', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ source: 'api' }),
        state: { last: LAST_SWEEP },
        addedLines: 0,
      });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        ended: [{ runId: result.runClaim.runId }],
        sweep: undefined,
      });
      expect(result.logged).toContain('no code added to sweep, and none left over');
    }),
  );

  it.effect('sweeps a carry-over when asked, with no code added since', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ source: 'api' }),
        addedLines: 0,
        state: { last: LAST_SWEEP, carryOver: [{ file: 'src/tax.ts', name: 'rate' }] },
      });
      expect(result.printed).toEqual(['sweep']);
    }),
  );

  it.effect.each<readonly [string, Record<string, string>]>([
    ['no principles doc', projectConfigFile()],
    ['an empty principles doc', { ...projectConfigFile(), ...EMPTY_DOC }],
  ])('waits for the principles doc to have principles: %s', ([, files]) =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ files });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        ended: [{ runId: result.runClaim.runId }],
        sweep: undefined,
      });
      expect(result.logged).toContain('the principles doc has no principles yet');
    }),
  );

  it.effect("waits while the last sweep's MR is open", () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        openBranches: ['feat/x', 'codetinder/sweep-2026-10-01-100000'],
      });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        ended: [{ runId: result.runClaim.runId }],
        sweep: undefined,
      });
      expect(result.logged).toContain("the last sweep's MR !11 is still open");
    }),
  );

  it.effect('stops, before reading the sweep, when another run holds it', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ claim: { _tag: 'Busy' } });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        finished: [],
        ended: [],
        sweep: undefined,
      });
      expect(result.logged).toContain('another run holds the sweep');
      expect(result.requests).not.toContain(`GET codetinder.dev/api/sweeps/${PROJECT_ID}`);
    }),
  );

  it.effect('reads the sweep only once it holds the claim', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({});
      const claimedAt = result.requests.indexOf(
        `POST codetinder.dev/api/sweeps/${PROJECT_ID}/claim`,
      );
      const readAt = result.requests.indexOf(`GET codetinder.dev/api/sweeps/${PROJECT_ID}`);
      expect(claimedAt).toBeGreaterThanOrEqual(0);
      expect(readAt).toBeGreaterThan(claimedAt);
    }),
  );

  it.effect('fetches a base the checkout lacks', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ state: { last: LAST_SWEEP }, base: 'fetched' });
      expect(result.printed).toEqual(['sweep']);
      expect(result.git).toContain(`git fetch --quiet --no-tags origin ${LAST_SHA}`);
    }),
  );

  it.effect("stops when gitlab.com won't give the base", () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ state: { last: LAST_SWEEP }, base: 'unfetchable' });
      expect(result).toMatchObject({
        printed: ['nosweep'],
        ended: [{ runId: result.runClaim.runId }],
        sweep: undefined,
      });
      expect(result.logged).toContain(`can't fetch ${LAST_SHA}`);
    }),
  );

  it.effect('reads the default branch from GitLab when the context has none', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ primaryBranch: null }),
      });
      expect(result.printed).toEqual(['sweep']);
      expect(result.requests).toContain(`GET gitlab.com/api/v4/projects/${PROJECT_ID}`);
    }),
  );

  it.effect('leaves a pipeline on another branch with no MR alone', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({
        context: pipelineContext({ branch: 'release', primaryBranch: null }),
      });
      expect(result).toMatchObject({ printed: ['nomergerequest'], claims: [], ended: [] });
    }),
  );

  it.effect('stops, saying why, without the ID token', () =>
    Effect.gen(function* () {
      const result = yield* runSweepRoute({ hasIdToken: false });
      expect(result).toMatchObject({ printed: ['nosweep'], claims: [], ended: [] });
      expect(result.logged).toContain('CODETINDER_ID_TOKEN');
    }),
  );
});
