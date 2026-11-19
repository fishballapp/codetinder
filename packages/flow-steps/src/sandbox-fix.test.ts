import {
  type EnvironmentFailure,
  SANDBOX_FIX_BRANCH_PREFIX,
  type SandboxFixItem,
  sandboxFixDescription,
} from '@codetinder/core';
import {
  GitLabCommits,
  GitLabFiles,
  type GitLabListedMergeRequest,
  GitLabMergeRequests,
  GitLabRequestFailed,
  GitLabSetup,
} from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as TestConsole from 'effect/testing/TestConsole';
import { proposeSandboxFix } from './sandbox-fix';

const HOST: SandboxFixItem = { _tag: 'Host', host: 'api.example.com' };
const OTHER: SandboxFixItem = { _tag: 'Host', host: 'cdn.example.com' };
const NEW_BRANCH = `${SANDBOX_FIX_BRANCH_PREFIX}0`;
const OPEN_BRANCH = `${SANDBOX_FIX_BRANCH_PREFIX}abc`;

const blocked = (...hosts: string[]): EnvironmentFailure => ({
  stage: 'tests',
  diagnosis: { _tag: 'BlockedHosts', hosts },
  outputTail: '',
});

const CONFIG = `id_tokens:
  CODETINDER_ID_TOKEN:
    aud: https://codetinder.dev
network_policy:
  allowed_domains:
    - registry.npmjs.org
`;

const withDomain = (config: string, domain: string) => `${config}    - ${domain}\n`;

const fixMergeRequest = (
  iid: number,
  items: readonly SandboxFixItem[],
  overrides: Partial<GitLabListedMergeRequest> = {},
): GitLabListedMergeRequest => ({
  iid,
  webUrl: `https://gitlab.com/acme/app/-/merge_requests/${iid}`,
  description: sandboxFixDescription(items),
  sourceBranch: OPEN_BRANCH,
  targetBranch: 'main',
  ...overrides,
});

type Calls = {
  commits: { branch: string; startSha?: string; lastCommitId?: string; content: string }[];
  created: { sourceBranch: string; targetBranch: string; description: string }[];
  updated: { iid: number; description: string }[];
  reads: string[];
};

const gitlab = ({
  calls,
  open = [],
  closed = [],
  files = { 'main-sha': CONFIG, [OPEN_BRANCH]: CONFIG },
  defaultBranch = 'main',
  refusals = 0,
}: {
  readonly calls: Calls;
  readonly open?: GitLabListedMergeRequest[];
  readonly closed?: GitLabListedMergeRequest[];
  readonly files?: Record<string, string>;
  readonly defaultBranch?: string;
  /** How many commits GitLab refuses first, as a file changed since it was read. */
  readonly refusals?: number;
}) => {
  const refused = { count: 0 };
  return Layer.mergeAll(
    Layer.succeed(
      GitLabMergeRequests,
      GitLabMergeRequests.of({
        get: () => Effect.die('not used by this test'),
        createNote: () => Effect.die('not used by this test'),
        finishReview: () => Effect.die('not used by this test'),
        latestReviewRequest: () => Effect.die('not used by this test'),
        replyToNote: () => Effect.die('not used by this test'),
        list: ({ state }) => Effect.succeed(state === 'opened' ? open : closed),
        updateDescription: ({ mergeRequestIid, description }) =>
          Effect.sync(() => void calls.updated.push({ iid: mergeRequestIid, description })),
        createMergeRequest: ({ sourceBranch, targetBranch, description }) =>
          Effect.sync(() => {
            calls.created.push({ sourceBranch, targetBranch, description });
            return { iid: 21, webUrl: 'https://gitlab.com/acme/app/-/merge_requests/21' };
          }),
      }),
    ),
    Layer.succeed(
      GitLabCommits,
      GitLabCommits.of({
        commit: ({ branch, startSha, files: committed }) => {
          if (refused.count < refusals) {
            refused.count += 1;
            return Effect.fail(new GitLabRequestFailed({ status: 400, message: 'file changed' }));
          }
          return Effect.sync(() => {
            const [file] = committed;
            calls.commits.push({
              branch,
              content: file?.content ?? '',
              ...(startSha === undefined ? {} : { startSha }),
              ...(file?.lastCommitId === undefined ? {} : { lastCommitId: file.lastCommitId }),
            });
            return { id: 'c1', webUrl: 'https://gitlab.com/acme/app/-/commit/c1' };
          });
        },
      }),
    ),
    Layer.succeed(
      GitLabSetup,
      GitLabSetup.of({
        defaultBranch: () => Effect.succeed(defaultBranch),
        branchHead: () => Effect.succeed('main-sha'),
        rootFileNames: () => Effect.die('not used by this test'),
        openSetupMergeRequest: () => Effect.die('not used by this test'),
      }),
    ),
    Layer.succeed(
      GitLabFiles,
      GitLabFiles.of({
        readText: () => Effect.die('not used by this test'),
        readRevision: ({ ref }) =>
          Effect.sync(() => {
            calls.reads.push(ref);
            const text = files[ref];
            return text === undefined
              ? Option.none()
              : Option.some({ text, lastCommitId: `last-${calls.reads.length}` });
          }),
      }),
    ),
    ConfigProvider.layer(
      ConfigProvider.fromUnknown({ DUO_WORKFLOW_PROJECT_ID: '123', GITLAB_TOKEN: 'token' }),
    ),
    TestConsole.layer,
  );
};

const newCalls = (): Calls => ({ commits: [], created: [], updated: [], reads: [] });

describe('proposeSandboxFix', () => {
  it.effect('opens a fix MR on a branch of its own, made from the default branch', () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(
        Option.some({ iid: 21, isNew: true }),
      );
      expect(calls.reads).toEqual(['main-sha']);
      expect(calls.commits).toEqual([
        {
          branch: NEW_BRANCH,
          startSha: 'main-sha',
          lastCommitId: 'last-1',
          content: withDomain(CONFIG, 'api.example.com'),
        },
      ]);
      expect(calls.created).toEqual([
        {
          sourceBranch: NEW_BRANCH,
          targetBranch: 'main',
          description: sandboxFixDescription([HOST]),
        },
      ]);
    }).pipe(Effect.provide(gitlab({ calls })));
  });

  it.effect('adds to the open fix MR, guarding its file, and lists what its branch now has', () => {
    const calls = newCalls();
    const open = [fixMergeRequest(9, [OTHER])];
    const branchConfig = withDomain(CONFIG, 'cdn.example.com');
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(
        Option.some({ iid: 9, isNew: false }),
      );
      expect(calls.reads).toEqual([OPEN_BRANCH]);
      expect(calls.commits).toEqual([
        {
          branch: OPEN_BRANCH,
          lastCommitId: 'last-1',
          content: withDomain(branchConfig, 'api.example.com'),
        },
      ]);
      expect(calls.updated).toEqual([
        { iid: 9, description: sandboxFixDescription([OTHER, HOST]) },
      ]);
      expect(calls.created).toEqual([]);
    }).pipe(Effect.provide(gitlab({ calls, open, files: { [OPEN_BRANCH]: branchConfig } })));
  });

  it.effect('reads again and retries once when the config changed under it', () => {
    const calls = newCalls();
    const open = [fixMergeRequest(9, [OTHER])];
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(
        Option.some({ iid: 9, isNew: false }),
      );
      expect(calls.reads).toEqual([OPEN_BRANCH, OPEN_BRANCH]);
      expect(calls.commits).toMatchObject([{ lastCommitId: 'last-2' }]);
      // The description says only what the branch has: the earlier fix isn't in this config.
      expect(calls.updated).toEqual([{ iid: 9, description: sandboxFixDescription([HOST]) }]);
    }).pipe(Effect.provide(gitlab({ calls, open, refusals: 1 })));
  });

  it.effect('treats a fix MR retargeted away from the default branch as not the open one', () => {
    const calls = newCalls();
    const open = [fixMergeRequest(9, [OTHER], { targetBranch: 'release' })];
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(
        Option.some({ iid: 21, isNew: true }),
      );
      expect(calls.commits).toMatchObject([{ branch: NEW_BRANCH, startSha: 'main-sha' }]);
    }).pipe(Effect.provide(gitlab({ calls, open })));
  });

  it.effect('points at the open fix MR that already has it, changing nothing', () => {
    const calls = newCalls();
    const open = [fixMergeRequest(9, [HOST])];
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(
        Option.some({ iid: 9, isNew: false }),
      );
      expect(calls.commits).toEqual([]);
    }).pipe(
      Effect.provide(
        gitlab({ calls, open, files: { [OPEN_BRANCH]: withDomain(CONFIG, 'api.example.com') } }),
      ),
    );
  });

  it.effect('never proposes again a fix the team closed', () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(Option.none());
      expect(calls.reads).toEqual([]);
    }).pipe(Effect.provide(gitlab({ calls, closed: [fixMergeRequest(4, [HOST])] })));
  });

  it.effect("proposes nothing when the default branch's config already allows it", () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('registry.npmjs.org'))).toEqual(Option.none());
      expect(calls.commits).toEqual([]);
    }).pipe(Effect.provide(gitlab({ calls })));
  });

  it.effect('proposes no library fix the config would leave out, even with other changes', () => {
    const calls = newCalls();
    const missing = (libraries: string[]): EnvironmentFailure => ({
      stage: 'install',
      diagnosis: { _tag: 'MissingLibraries', libraries },
      outputTail: '',
    });
    return Effect.gen(function* () {
      // A custom image leaves out the microdnf line; the ID token alone would still be added.
      expect(yield* proposeSandboxFix(missing(['libnss3.so']))).toEqual(Option.none());
      expect(yield* proposeSandboxFix(missing(['libmystery.so.9']))).toEqual(Option.none());
      expect(calls.commits).toEqual([]);
      expect(calls.created).toEqual([]);
    }).pipe(Effect.provide(gitlab({ calls, files: { 'main-sha': 'image: node:24\n' } })));
  });

  it.effect('never commits to a branch named like the default branch', () => {
    const calls = newCalls();
    return Effect.gen(function* () {
      expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(Option.none());
      expect(calls.commits).toEqual([]);
    }).pipe(Effect.provide(gitlab({ calls, defaultBranch: NEW_BRANCH })));
  });

  it.effect(
    'never fails the run: a refused commit proposes nothing, and says why on stderr',
    () => {
      const calls = newCalls();
      return Effect.gen(function* () {
        expect(yield* proposeSandboxFix(blocked('api.example.com'))).toEqual(Option.none());
        expect(yield* TestConsole.errorLines).toEqual([
          "couldn't propose a sandbox fix: file changed",
        ]);
        expect(yield* TestConsole.logLines).toEqual([]);
      }).pipe(Effect.provide(gitlab({ calls, refusals: 2 })));
    },
  );
});
