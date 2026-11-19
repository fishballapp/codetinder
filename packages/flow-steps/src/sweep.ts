import type { SweepFunction, SweepStopCause } from '@codetinder/api';
import {
  type DroppedFinding,
  isRewritable,
  nextCarryOver,
  oneLine,
  PRINCIPLES_PATH,
  pickSweep,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  rulesOf,
  SWEEP_RUN_FILES,
  SweepAnswerSchema,
  stripCodeFence,
  sweepBranch,
  sweepCommitMessage,
  sweepDescription,
  sweepTitle,
} from '@codetinder/core';
import {
  type GitLabCommitFile,
  GitLabCommits,
  GitLabMergeRequests,
  GitLabSweeps,
} from '@codetinder/gitlab';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { type RunClaim, readRunClaim } from './claim';
import { CodeTinder } from './codetinder';
import { handOverForCorrection, type Rejected, rejected } from './correction';
import { readPrinciples } from './principles-file';
import { readProjectConfig } from './project-config-file';
import { logSession } from './session-log';
import { listWorkingTreeChanges } from './shell';
import {
  changedCodeFilesSince,
  readSweepPicks,
  readSweepRun,
  readSweepStop,
  type SweepStop,
  writeSweepPicks,
  writeSweepStop,
} from './sweep-run';
import { TASK_FILE } from './task';
import { messageOf } from './user-error';
import { TESTS_FAILED } from './verify';

/** The text of each of `files` that exists in the checkout. */
const readExisting = Effect.fn('sweep.readExisting')(function* (files: Iterable<string>) {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* Effect.forEach(
    files,
    file =>
      fs.readFileString(file).pipe(
        Effect.option,
        Effect.map(text => Option.map(text, (content): [string, string] => [file, content])),
      ),
    { concurrency: 'unbounded' },
  );
  return new Map(read.flatMap(Option.toArray));
});

/** What `sweep pick` makes of the agent's answer, before it prints it. */
type Pick =
  | { readonly _tag: 'Picked' }
  | { readonly _tag: 'Clean' }
  | Rejected
  | ({ readonly _tag: 'Failed' } & SweepStop);

const pickFailed = (cause: SweepStopCause, reason: string): Pick => ({
  _tag: 'Failed',
  cause,
  reason,
});

/** Each finding the sweep dropped and why, for the agent to correct. */
const describeDropped = (dropped: readonly DroppedFinding[]): string =>
  dropped
    .map(({ finding: { file, name }, why }) => `- \`${name}\` in \`${file}\`: ${why}`)
    .join('\n');

/**
 * Checks the sweep agent's answer and keeps what the rewrite takes on: `Picked` when it has
 * functions to rewrite, `Clean` when the code reached follows the principles. An answer the agent
 * can correct is `Rejected`: one that doesn't decode, or whose every function is one the sweep
 * can't take on (a file it doesn't reach, a name the file lacks, no principle the doc has). Some
 * of them the sweep can't take on is no fault: it rewrites the rest.
 */
const pick = Effect.fn('sweep.pick')(function* (answerFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(answerFile).pipe(Effect.option);
  const noAnswer = 'the agent gave no answer';
  if (Option.isNone(text)) return pickFailed('Answer', noAnswer);
  const answer = yield* Schema.decodeEffect(Schema.fromJsonString(SweepAnswerSchema))(
    stripCodeFence(text.value),
  ).pipe(Effect.result);
  if (Result.isFailure(answer)) {
    const { message } = answer.failure;
    const invalid = `the answer is invalid: ${oneLine(message)}`;
    return rejected(invalid, message);
  }

  const { base, carryOver } = yield* readSweepRun();
  const changed = yield* changedCodeFilesSince(base);
  const files = yield* readExisting(new Set([...changed, ...carryOver.map(({ file }) => file)]));
  const principleIds = new Set(rulesOf(yield* readPrinciples()).map(({ id }) => id));
  const { functions } = answer.success;
  const picks = pickSweep({ findings: functions, files, principleIds });
  const isEveryFindingDropped = functions.length > 0 && picks.kept.length === 0;
  if (isEveryFindingDropped) {
    const noneKept = `none of the ${functions.length} functions found is one the sweep can take on`;
    return rejected(noneKept, describeDropped(picks.dropped));
  }
  yield* writeSweepPicks(picks);
  yield* Console.error(
    `kept ${picks.kept.length} of the ${functions.length} functions found; ${picks.left.length} left for the next sweep`,
  );
  if (picks.dropped.length > 0) {
    yield* Console.error(`dropped:\n${describeDropped(picks.dropped)}`);
  }
  yield* logSession(
    picks.kept.length === 0
      ? `None of the ${functions.length} functions the agent found needs a rewrite`
      : `Picked ${picks.kept.length} of the ${functions.length} functions the agent found to rewrite; ${picks.left.length} left for the next sweep`,
  );
  if (picks.kept.length === 0) return { _tag: 'Clean' } as const;
  return { _tag: 'Picked' } as const;
});

/** Keeps why the pick stopped the sweep, for `sweep propose`, and prints `failed: <reason>`. */
const stopPick = Effect.fn('sweep.stopPick')(function* (stop: SweepStop) {
  yield* writeSweepStop(stop);
  yield* logSession(`The sweep stopped: ${oneLine(stop.reason)}`);
  yield* Console.log(`failed: ${oneLine(stop.reason)}`);
});

/**
 * Prints what the sweep takes on: `picked`, `clean`, or `failed: <reason>` with the reason kept
 * for `sweep propose`, which ends the sweep after it. With `canCorrect`, an answer the agent can
 * correct ends nothing yet: it prints `correct`, and the next `sweep pick` decides.
 */
export const runSweepPick = Effect.fn('sweep.runPick')(function* (
  answerFile: string,
  { canCorrect }: { readonly canCorrect: boolean },
) {
  const fault = (error: { readonly message: string }) =>
    Effect.succeed(pickFailed('Error', oneLine(error.message)));
  const picked: Pick = yield* pick(answerFile).pipe(
    Effect.catchTags({ UserError: fault, GitFailed: fault }),
  );
  switch (picked._tag) {
    case 'Picked':
    case 'Clean':
      yield* Console.log(picked._tag.toLowerCase());
      return;
    case 'Rejected':
      if (canCorrect && (yield* handOverForCorrection(answerFile, picked))) return;
      return yield* stopPick({ cause: 'Answer', reason: picked.reason });
    case 'Failed':
      return yield* stopPick({ cause: picked.cause, reason: picked.reason });
  }
});

/**
 * How a sweep ends: an MR, nothing to change, or stopped short, to try again at the next merge;
 * or overtaken, its claim another run's now.
 */
type SweepOutcome =
  | {
      readonly _tag: 'Proposed';
      readonly mergeRequestIid: number;
      readonly carryOver: readonly SweepFunction[];
    }
  | { readonly _tag: 'Clean'; readonly carryOver: readonly SweepFunction[] }
  | ({ readonly _tag: 'Stopped' } & SweepStop)
  | { readonly _tag: 'TakenOver' };

const stopped = (cause: SweepStopCause, reason: string): SweepOutcome => ({
  _tag: 'Stopped',
  cause,
  reason,
});

/**
 * Why the rewrite can't be proposed, from the last `verify sweep` verdict; none once verified. The
 * sandbox is to blame when the install or tests fail before any change.
 */
const readRewriteFailure = Effect.fn('sweep.readRewriteFailure')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const verdict = yield* fs.readFileString(REWRITE_STATE_FILES.verdict).pipe(Effect.option);
  if (Option.isNone(verdict)) return Option.some(stopped('Error', "the rewrite didn't run"));
  const line = verdict.value.trim();
  if (line === 'verified') return Option.none();
  const reason = line.replace(/^failed: /, '');
  const isSandboxFault = yield* fs.exists(REWRITE_STATE_FILES.environment).pipe(Effect.orDie);
  if (isSandboxFault) return Option.some(stopped('Sandbox', reason));
  const cause = reason === TESTS_FAILED ? 'Tests' : 'Error';
  return Option.some(stopped(cause, reason));
});

/** Why nothing was picked: what `sweep pick` kept, or the sweep's task never written. */
const noPicks = readSweepStop().pipe(
  Effect.map(({ cause, reason }) => stopped(cause, reason)),
  Effect.orElseSucceed(() => stopped('Error', "the sweep's task or its pick didn't run")),
);

/** Commits the verified rewrite on a branch of its own and opens its MR into the default branch. */
const sweepOutcome = Effect.fn('sweep.outcome')(function* ({
  projectId,
  claim,
}: {
  readonly projectId: string;
  readonly claim: RunClaim;
}) {
  const picks = yield* readSweepPicks().pipe(Effect.option);
  if (Option.isNone(picks)) return yield* noPicks;
  const { kept, left } = picks.value;
  if (kept.length === 0) return { _tag: 'Clean', carryOver: left } satisfies SweepOutcome;

  const failure = yield* readRewriteFailure();
  if (Option.isSome(failure)) return failure.value;

  // Only the kept functions' files are proposed, whatever else the working tree holds.
  const scope = new Set(kept.map(({ file }) => file));
  const files = (yield* listWorkingTreeChanges())
    .filter(({ path, isUntracked }) => !isUntracked && isRewritable(path, scope))
    .map(({ path }) => path);
  // A pick whose file the rewrite left alone wasn't swept: the next sweep takes it on first.
  if (files.length === 0) {
    yield* Console.error('the rewrite changed nothing');
    return { _tag: 'Clean', carryOver: nextCarryOver(kept, left) } satisfies SweepOutcome;
  }
  // ponytail: swept is judged by file, so a pick the rewrite skipped in a file it did change counts
  // as swept and isn't carried over; telling them apart needs the rewrite to name what it changed,
  // and the cost is one style fix waiting until its file changes again.
  const swept = kept.filter(({ file }) => files.includes(file));
  const unswept = kept.filter(({ file }) => !files.includes(file));
  const carryOver = nextCarryOver(unswept, left);

  // The checks can outlast the claim, which another run then takes: only its owner publishes.
  const stillOurs = yield* (yield* CodeTinder).claimSweep(projectId, claim);
  if (stillOurs._tag === 'Busy') return { _tag: 'TakenOver' } satisfies SweepOutcome;

  const fs = yield* FileSystem.FileSystem;
  const contents = yield* Effect.forEach(files, file =>
    fs.readFileString(file).pipe(
      Effect.orDie,
      Effect.map((content): GitLabCommitFile => ({ path: file, content, action: 'update' })),
    ),
  );
  const config = yield* readProjectConfig();
  const tone = config._tag === 'Ok' ? config.config.tone : 'plain';
  const { defaultBranch, webUrl } = yield* (yield* GitLabSweeps).project({ projectId });
  const branch = sweepBranch(yield* Clock.currentTimeMillis);
  yield* (yield* GitLabCommits).commit({
    projectId,
    branch,
    startSha: claim.headSha,
    message: sweepCommitMessage(swept),
    files: contents,
  });
  const { iid } = yield* (yield* GitLabMergeRequests).createMergeRequest({
    projectId,
    sourceBranch: branch,
    targetBranch: defaultBranch,
    title: sweepTitle({ tone, count: swept.length }),
    description: sweepDescription({
      tone,
      functions: swept,
      principles: yield* readPrinciples(),
      principlesUrl: `${webUrl}/-/blob/${defaultBranch}/${PRINCIPLES_PATH}`,
      leftCount: carryOver.length,
    }),
  });
  return { _tag: 'Proposed', mergeRequestIid: iid, carryOver } satisfies SweepOutcome;
});

const removeRunFiles = Effect.flatMap(FileSystem.FileSystem, fs =>
  Effect.forEach(
    [TASK_FILE, ...Object.values(SWEEP_RUN_FILES), ...Object.values(REWRITE_RUN_FILES)],
    file => fs.remove(file).pipe(Effect.ignore),
    { discard: true },
  ),
);

/**
 * Ends every sweep that started: opens its MR and finishes it on codetinder.dev, moving the last
 * sweep to this commit with the functions it didn't rewrite; finishes it with no MR when there was
 * nothing to change; stops without a word to codetinder.dev when another run took its claim over;
 * and otherwise records it stopped, with why, and gives the claim up, leaving the last sweep where
 * it was so the next counts from there. It posts nothing: there is no MR to post on. The reason a
 * sweep stopped goes to stderr.
 */
export const runSweepPropose = Effect.fn('sweep.propose')(function* () {
  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  const claim = yield* readRunClaim();
  const outcome: SweepOutcome = yield* sweepOutcome({ projectId, claim }).pipe(
    Effect.catchTags({
      UserError: error => Effect.succeed(stopped('Error', error.message)),
      GitFailed: error => Effect.succeed(stopped('Error', error.message)),
      GitLabRequestFailed: error =>
        Effect.succeed(stopped('GitLab', `GitLab refused the sweep: ${error.message}`)),
      Unauthorized: error => Effect.succeed(stopped('Error', error.message)),
      Forbidden: error => Effect.succeed(stopped('Error', error.message)),
    }),
    Effect.catchDefect(defect =>
      Effect.succeed(stopped('Error', `CodeTinder hit an unexpected error: ${messageOf(defect)}`)),
    ),
  );

  const codetinder = yield* CodeTinder;
  // A claim taken over past its hold is another run's now: the record is its to write.
  const unrecorded = (doing: string) => (error: { readonly message: string }) =>
    Console.error(`couldn't ${doing} the sweep on codetinder.dev: ${oneLine(error.message)}`);
  if (outcome._tag === 'TakenOver') {
    // The claim is the other run's: giving it up would end that run's sweep.
    yield* Console.error('sweep stopped: another run took the sweep over before it was proposed');
    yield* logSession('The sweep stopped: another run took it over');
    yield* Console.log('stopped: another run took the sweep over');
    return;
  }
  if (outcome._tag === 'Stopped') {
    yield* Console.error(`sweep stopped: ${oneLine(outcome.reason)}`);
    yield* codetinder
      .stopSweep(projectId, { runId: claim.runId, cause: outcome.cause })
      .pipe(Effect.catch(unrecorded('stop')));
    yield* logSession(`The sweep stopped: ${oneLine(outcome.reason)}`);
    yield* Console.log(`stopped: ${oneLine(outcome.reason)}`);
    return;
  }
  yield* codetinder
    .finishSweep(projectId, {
      ...claim,
      outcome:
        outcome._tag === 'Proposed'
          ? { _tag: 'Proposed', mergeRequestIid: outcome.mergeRequestIid }
          : { _tag: 'Clean' },
      carryOver: outcome.carryOver,
    })
    .pipe(Effect.catch(unrecorded('finish')));
  yield* logSession(
    outcome._tag === 'Proposed'
      ? `Opened !${outcome.mergeRequestIid} with the sweep's rewrite`
      : 'The sweep found nothing to rewrite',
  );
  yield* Console.log(
    outcome._tag === 'Proposed' ? `proposed !${outcome.mergeRequestIid}` : 'clean',
  );
}, Effect.ensuring(removeRunFiles));

const pickCommand = Command.make(
  'pick',
  {
    answerFile: Argument.String('answer-file').pipe(
      Argument.withDescription("The sweep agent's answer, a JSON file"),
    ),
    canCorrect: Flag.Boolean('can-correct').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'On an answer the agent can correct, print `correct` and keep the error for `task sweep-retry`, instead of failing',
      ),
    ),
  },
  ({ answerFile, canCorrect }) => runSweepPick(answerFile, { canCorrect }),
).pipe(
  Command.withDescription(
    "Check the sweep agent's answer and keep the functions this sweep rewrites",
  ),
);

const proposeCommand = Command.make('propose', {}, () =>
  runSweepPropose().pipe(
    Effect.provide(
      Layer.mergeAll(
        CodeTinder.layer,
        GitLabSweeps.layer,
        GitLabCommits.layer,
        GitLabMergeRequests.layer,
      ),
    ),
  ),
).pipe(
  Command.withDescription(
    "Open the sweep's MR and finish the sweep on codetinder.dev, or give it up",
  ),
);

export const sweepCommand = Command.make('sweep').pipe(
  Command.withDescription("A sweep's steps after its agent: pick the functions, then propose"),
  Command.withSubcommands([pickCommand, proposeCommand]),
);
