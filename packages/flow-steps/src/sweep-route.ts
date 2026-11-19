import {
  type BranchPipeline,
  oneLine,
  parseNumstat,
  SWEEP_BRANCH_PREFIX,
  sweepLineCount,
} from '@codetinder/core';
import { GitLabSweeps } from '@codetinder/gitlab';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import { NO_ID_TOKEN_REASON, startRunClaim } from './claim';
import { CodeTinder } from './codetinder';
import { readPrinciples } from './principles-file';
import { logSession } from './session-log';
import { runCapturingStdout } from './shell';
import { diffSince, firstSweepBase, writeSweepRun } from './sweep-run';
import { messageOf } from './user-error';

/** Why a run on the default branch doesn't sweep, on stderr, which `unrouted` prints. */
const noSweep = (reason: string) =>
  Console.error(`no sweep: ${oneLine(reason)}`).pipe(
    Effect.andThen(logSession(`No sweep: ${oneLine(reason)}`)),
    Effect.as('nosweep' as const),
  );

/**
 * `sha` in the checkout, fetched if the clone lacks it. The run's clone is full, so only a commit
 * the branch's history no longer has (a force-push) needs the fetch; if gitlab.com won't give it,
 * there is nothing to count from.
 */
const hasCommit = Effect.fn('sweepRoute.hasCommit')(function* (sha: string) {
  const isPresent = Effect.map(
    runCapturingStdout('git', ['cat-file', '-e', `${sha}^{commit}`]),
    ({ exitCode }) => exitCode === 0,
  );
  if (yield* isPresent) return true;
  yield* runCapturingStdout('git', ['fetch', '--quiet', '--no-tags', 'origin', sha]);
  return yield* isPresent;
});

/** The lines of code added since the last sweep's commit, which the next one counts from. */
const sinceLastSweep = Effect.fn('sweepRoute.sinceLastSweep')(function* (sha: string) {
  const numstat = yield* diffSince(sha, ['--numstat', '-z']);
  return { base: sha, lines: sweepLineCount(parseNumstat(numstat)) };
});

/** What a run holding the sweep's claim decides. */
type Decision = { readonly _tag: 'Sweep' } | { readonly _tag: 'NoSweep'; readonly reason: string };

const notDue = (reason: string): Decision => ({ _tag: 'NoSweep', reason });

/**
 * Whether a sweep is due, decided on the state read under the run's claim, so no other run can
 * finish a sweep in between: when the code added since the last sweep (for the first, the latest
 * commits', walked back until it does) reaches the project's threshold, or at once when a developer
 * asked for it (a pipeline started through the API, as "Sweep now" does) and there is something to
 * sweep. Never while the principles doc has no principles, or the last sweep's MR is still open.
 */
const decide = Effect.fn('sweepRoute.decide')(function* ({
  projectId,
  pipeline,
}: {
  readonly projectId: string;
  readonly pipeline: BranchPipeline;
}) {
  const codetinder = yield* CodeTinder;
  const gitlab = yield* GitLabSweeps;
  const { last, threshold, carryOver } = yield* codetinder.getSweep(projectId);

  if (last !== null && !(yield* hasCommit(last.sha))) {
    return notDue(`can't fetch ${last.sha}, the commit the sweep counts from`);
  }
  const { base, lines } =
    last === null ? yield* firstSweepBase(threshold) : yield* sinceLastSweep(last.sha);
  const isManual = pipeline.source === 'api';
  if (!isManual && lines < threshold) {
    return notDue(`${lines} lines of code added, short of the threshold ${threshold}`);
  }
  const hasNothingToSweep = lines === 0 && carryOver.length === 0;
  if (isManual && hasNothingToSweep) {
    return notDue('no code added to sweep, and none left over');
  }

  const principles = yield* readPrinciples();
  if (principles.length === 0) return notDue('the principles doc has no principles yet');

  const open = yield* gitlab.openMergeRequestsFrom({
    projectId,
    branchPrefix: SWEEP_BRANCH_PREFIX,
  });
  if (open.length > 0) return notDue(`the last sweep's MR !${open.join(', !')} is still open`);

  yield* writeSweepRun({ base, carryOver });
  return { _tag: 'Sweep' } satisfies Decision;
});

/**
 * Takes the sweep's claim, then decides under it: `sweep` when this run sweeps, else `nosweep`
 * with the reason on stderr, giving up the claim it took.
 */
const claimAndDecide = Effect.fn('sweepRoute.claimAndDecide')(function* ({
  projectId,
  pipeline,
}: {
  readonly projectId: string;
  readonly pipeline: BranchPipeline;
}) {
  const codetinder = yield* CodeTinder;
  const claim = yield* startRunClaim();
  const answer = yield* codetinder.claimSweep(projectId, claim);
  if (answer._tag === 'Busy') return yield* noSweep('another run holds the sweep');

  const failed = (failure: { readonly message: string }) => Effect.succeed(notDue(failure.message));
  const decision: Decision = yield* decide({ projectId, pipeline }).pipe(
    Effect.catchTags({
      Unauthorized: failed,
      Forbidden: failed,
      GitLabRequestFailed: failed,
      GitFailed: failed,
      UserError: failed,
    }),
  );
  if (decision._tag === 'Sweep') return 'sweep' as const;
  // ponytail: a claim that can't be given up times out on its own, past the sweep's longest run.
  yield* codetinder
    .endSweep(projectId, { runId: claim.runId })
    .pipe(
      Effect.catch(error => Console.error(`couldn't give up the sweep: ${oneLine(error.message)}`)),
    );
  return yield* noSweep(decision.reason);
});

/**
 * The route of a pipeline on a branch with no open merge request: on the default branch, `sweep`
 * when this run holds the sweep and one is due, and `nosweep` when not; on any other,
 * `nomergerequest`. Whatever stops a sweep from starting ends the run quietly, its reason on
 * stderr: there is no MR to post on.
 */
export const routeBranchPipeline = Effect.fn('sweepRoute.route')(function* (
  pipeline: BranchPipeline,
) {
  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  const defaultBranch =
    pipeline.defaultBranch ?? (yield* (yield* GitLabSweeps).project({ projectId })).defaultBranch;
  if (pipeline.branch !== defaultBranch) return 'nomergerequest' as const;

  const stopped = (failure: unknown) => noSweep(messageOf(failure));
  return yield* claimAndDecide({ projectId, pipeline }).pipe(
    Effect.provide(CodeTinder.layer),
    Effect.catchTags({
      ConfigError: () => noSweep(NO_ID_TOKEN_REASON),
      Unauthorized: stopped,
      Forbidden: stopped,
      UserError: stopped,
    }),
  );
});
