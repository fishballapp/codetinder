import {
  AGENT_CONFIG_PATH,
  type EnvironmentFailure,
  isProposedIn,
  isSameSandboxFixItem,
  isSandboxFixMergeRequest,
  mergeAgentConfig,
  oneLine,
  SANDBOX_FIX_BRANCH_PREFIX,
  SANDBOX_FIX_SEARCH,
  SANDBOX_FIX_TITLE,
  type SandboxFixItem,
  type SandboxFixMergeRequest,
  sandboxFixDescription,
  sandboxFixItems,
  sandboxFixItemsIn,
  sandboxFixItemsOf,
  sandboxFixNeeds,
} from '@codetinder/core';
import { GitLabCommits, GitLabFiles, GitLabMergeRequests, GitLabSetup } from '@codetinder/gitlab';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import type * as Redacted from 'effect/Redacted';
import { messageOf } from './user-error';

/** What one attempt at the fix's commit came to. */
type Attempt =
  // Committed: `items` are every fix the branch now has, its earlier ones included.
  | { readonly _tag: 'Committed'; readonly items: readonly SandboxFixItem[] }
  // The config there has the fix already: nothing to commit.
  | { readonly _tag: 'AlreadyThere' }
  // The config can't take every item (a custom image, a config it can't merge into): no fix.
  | { readonly _tag: 'NotFixable' };

/**
 * Reads the agent config at `ref`, merges `wanted` in and commits it onto `branch` (made from
 * `startSha` when given), naming the commit the file was read at, so GitLab refuses it if the file
 * changed since rather than lose that change. Committed only when every wanted item ends up in the
 * config: a fix that claims a package the merge left out would install nothing.
 */
const attemptFix = ({
  projectId,
  token,
  branch,
  ref,
  startSha,
  wanted,
  proposed,
}: {
  readonly projectId: string;
  readonly token: Redacted.Redacted<string>;
  readonly branch: string;
  readonly ref: string;
  readonly startSha: string | undefined;
  readonly wanted: readonly SandboxFixItem[];
  readonly proposed: readonly SandboxFixItem[];
}) =>
  Effect.gen(function* () {
    const read = yield* (yield* GitLabFiles)
      .readRevision({ token, projectId, path: AGENT_CONFIG_PATH, ref })
      .pipe(Effect.catchTag('FileNotUtf8', () => Effect.succeed(undefined)));
    if (read === undefined) return { _tag: 'NotFixable' } satisfies Attempt;

    const text = Option.map(read, ({ text }) => text);
    const merge = mergeAgentConfig(Option.getOrUndefined(text), sandboxFixNeeds(wanted));
    if (merge._tag === 'Conflict') return { _tag: 'NotFixable' } satisfies Attempt;
    const content = merge._tag === 'Merged' ? merge.content : Option.getOrElse(text, () => '');
    if (sandboxFixItemsIn(content, wanted).length < wanted.length) {
      return { _tag: 'NotFixable' } satisfies Attempt;
    }
    if (merge._tag === 'Unchanged') return { _tag: 'AlreadyThere' } satisfies Attempt;

    yield* (yield* GitLabCommits).commit({
      projectId,
      branch,
      ...(startSha === undefined ? {} : { startSha }),
      message: `fix: let CodeTinder's sandbox run this project\n\n${sandboxFixDescription(wanted)}`,
      files: [
        Option.match(read, {
          onNone: () => ({ path: AGENT_CONFIG_PATH, content, action: 'create' as const }),
          onSome: ({ lastCommitId }) => ({
            path: AGENT_CONFIG_PATH,
            content,
            action: 'update' as const,
            lastCommitId,
          }),
        }),
      ],
    });
    // The description is rebuilt from what the branch has, not from what was asked.
    const candidates = [
      ...proposed,
      ...wanted.filter(item => !proposed.some(other => isSameSandboxFixItem(item, other))),
    ];
    return { _tag: 'Committed', items: sandboxFixItemsIn(content, candidates) } satisfies Attempt;
  });

/** A commit GitLab refused because the file changed since it was read: worth one fresh try. */
const isStale = (error: { readonly _tag: string }) =>
  error._tag === 'GitLabRequestFailed' && 'status' in error && error.status === 400;

const proposeFix = Effect.fn('sandboxFix.proposeFix')(function* (items: readonly SandboxFixItem[]) {
  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  const token = yield* Config.Redacted('GITLAB_TOKEN');
  const mergeRequests = yield* GitLabMergeRequests;
  const none = Option.none<SandboxFixMergeRequest>();
  const fixes = (state: 'opened' | 'closed') =>
    mergeRequests
      .list({ projectId, state, search: SANDBOX_FIX_SEARCH })
      .pipe(Effect.map(listed => listed.filter(isSandboxFixMergeRequest)));

  // A fix the team closed is a no: it isn't proposed again.
  const closed = yield* fixes('closed');
  const wanted = items.filter(
    item => !closed.some(({ description }) => isProposedIn(description, item)),
  );
  if (wanted.length === 0) return none;

  const setup = yield* GitLabSetup;
  const defaultBranch = yield* setup.defaultBranch({ token, projectId });
  // Only a fix still aimed at the default branch is the open one; a retargeted MR is someone's own.
  const open = (yield* fixes('opened')).find(({ targetBranch }) => targetBranch === defaultBranch);
  const startSha =
    open === undefined
      ? yield* setup.branchHead({ token, projectId, branch: defaultBranch })
      : undefined;
  const branch =
    open?.sourceBranch ??
    `${SANDBOX_FIX_BRANCH_PREFIX}${(yield* Clock.currentTimeMillis).toString(36)}`;
  if (branch === defaultBranch) return none;

  const attempt = yield* attemptFix({
    projectId,
    token,
    branch,
    ref: startSha ?? branch,
    startSha,
    wanted,
    proposed: open === undefined ? [] : sandboxFixItemsOf(open.description),
  }).pipe(Effect.retry({ times: 1, while: isStale }));

  if (attempt._tag === 'NotFixable') return none;
  if (attempt._tag === 'AlreadyThere') {
    // The open fix has it: point at it. The default branch having it, and still failing, isn't ours.
    return open === undefined ? none : Option.some({ iid: open.iid, isNew: false });
  }
  if (open !== undefined) {
    yield* mergeRequests.updateDescription({
      projectId,
      mergeRequestIid: open.iid,
      description: sandboxFixDescription(attempt.items),
    });
    return Option.some({ iid: open.iid, isNew: false });
  }
  const { iid } = yield* mergeRequests.createMergeRequest({
    projectId,
    sourceBranch: branch,
    targetBranch: defaultBranch,
    title: SANDBOX_FIX_TITLE,
    description: sandboxFixDescription(attempt.items),
  });
  return Option.some({ iid, isNew: true });
});

/**
 * Proposes the agent-config change that fixes `environment`'s failure, in CodeTinder's one open fix
 * MR: added to it when one is open, opened on a new branch otherwise, never on the default branch
 * itself or over anyone's commits. Two runs racing to open one may open two; rare, and the team
 * merges either. None when
 * the diagnosis isn't one config fixes, the team closed a fix for it, or the default branch's config
 * already has it or can't take it (a custom image, a config it can't merge into). Never fails: the
 * failure's note is posted either way.
 */
export const proposeSandboxFix = Effect.fn('sandboxFix.propose')(function* (
  environment: EnvironmentFailure,
) {
  const items = sandboxFixItems(environment.diagnosis);
  if (items.length === 0) return Option.none<SandboxFixMergeRequest>();
  // On stderr: stdout's last line is the step's verdict, which the flow's router reads.
  const skip = (failure: unknown) =>
    Console.error(`couldn't propose a sandbox fix: ${oneLine(messageOf(failure))}`).pipe(
      Effect.as(Option.none<SandboxFixMergeRequest>()),
    );
  return yield* proposeFix(items).pipe(Effect.catch(skip), Effect.catchDefect(skip));
});
