import type { RoundId } from '@codetinder/api';
import {
  AnswerCorrectionSchema,
  CitationsSchema,
  CORRECTION_STATE_FILE,
  citationsOf,
  correctionTask,
  evidenceOnDoc,
  generateTask,
  LEARN_STATE_FILES,
  learnTask,
  oneLine,
  parseChangedCode,
  REWRITE_STATE_FILES,
  renderTask,
  rewriteTask,
  sweepRewriteTask,
  sweepTask,
  type TaskStep,
  TaskStepSchema,
  tallyVerdicts,
} from '@codetinder/core';
import { GitLabMergeRequests } from '@codetinder/gitlab';
import * as Cause from 'effect/Cause';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { CodeTinder } from './codetinder';
import { readLearnRoute, readMergeRequestIid } from './goal';
import { findWrittenRules, readCurrentPrinciplesDoc, readPrinciples } from './principles-file';
import { writeQuestionsSnapshot } from './questions-snapshot';
import { listWorkingTreeChanges, runCapturingStdout } from './shell';
import { diffSince, readSweepPicks, readSweepRun } from './sweep-run';
import { userError } from './user-error';

export const TASK_FILE = '.codetinder/task.md';

/**
 * How long a task waits for what codetinder.dev only helps with (generate's questions, learn's
 * evidence), retries included, before going on without it.
 */
const CODETINDER_READ_TIMEOUT = '20 seconds';

const runLearnTask = Effect.fn('task.runLearnTask')(function* () {
  const { roundId } = yield* readLearnRoute();
  const codetinder = yield* CodeTinder;
  const current = yield* readCurrentPrinciplesDoc();
  const writtenRules = yield* findWrittenRules();

  const mapApiError = {
    RoundNotFound: (error: { readonly message: string }) =>
      userError(error, `round not found: ${error.message}`),
    Forbidden: (error: { readonly message: string }) =>
      userError(error, `forbidden to read the round: ${error.message}`),
    Unauthorized: (error: { readonly message: string }) =>
      userError(error, `not authorized to read the round: ${error.message}`),
  };

  const stored = yield* codetinder.getRound(roundId).pipe(Effect.catchTags(mapApiError));
  const { swipes } = yield* codetinder.getSwipes(roundId).pipe(Effect.catchTags(mapApiError));
  const tallies = tallyVerdicts(stored.round, swipes);
  const evidence = yield* earlierEvidence(roundId);
  // Kept out of the agent's reach, for render to check the cards a narrow cites.
  yield* writeCitations(citationsOf({ tallies, evidence: evidenceOnDoc(current, evidence) }));

  return renderTask(learnTask({ current, writtenRules, round: stored.round, tallies, evidence }));
});

const writeCitations = Effect.fn('task.writeCitations')(function* (
  citations: ReadonlyMap<string, number>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(CitationsSchema))(
    Object.fromEntries(citations),
  ).pipe(Effect.orDie);
  yield* fs
    .makeDirectory(path.dirname(LEARN_STATE_FILES.citations), { recursive: true })
    .pipe(Effect.orDie);
  yield* fs.writeFileString(LEARN_STATE_FILES.citations, text).pipe(Effect.orDie);
});

/**
 * What earlier rounds say about the principles the round tests, or none when codetinder.dev
 * can't say in time: learn then weighs this round's swipes alone.
 */
const earlierEvidence = Effect.fn('task.earlierEvidence')(
  function* (roundId: RoundId) {
    const codetinder = yield* CodeTinder;
    const { evidence } = yield* codetinder.getEvidence(roundId);
    return evidence;
  },
  Effect.timeout(CODETINDER_READ_TIMEOUT),
  Effect.catchCause(cause =>
    Console.error(`learning without earlier evidence: ${oneLine(Cause.pretty(cause))}`).pipe(
      Effect.as([]),
    ),
  ),
);

/** The run's merge request: its iid, and the target branch GitLab names. */
const readMergeRequest = Effect.fn('task.readMergeRequest')(function* () {
  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  const mergeRequestIid = yield* readMergeRequestIid();
  const gitlab = yield* GitLabMergeRequests;
  const { targetBranch } = yield* gitlab
    .get({ projectId, mergeRequestIid })
    .pipe(
      Effect.mapError(error => userError(error, `can't read the merge request: ${error.message}`)),
    );
  return { mergeRequestIid, targetBranch };
});

/** `git diff <flags> origin/<targetBranch>...HEAD`: what the merge request changes. */
const gitDiff = Effect.fn('task.gitDiff')(function* (
  targetBranch: string,
  flags: readonly string[],
) {
  // git with an argument list, never a shell: the branch name is the MR author's text.
  const git = yield* runCapturingStdout('git', ['diff', ...flags, `origin/${targetBranch}...HEAD`]);
  if (git.exitCode !== 0) {
    return yield* userError({
      message: `can't read the merge request's diff: git diff exited ${git.exitCode}`,
    });
  }
  return git.stdout;
});

/** `git diff <flags> origin/<target>...HEAD` for the run's merge request. */
export const diffMergeRequest = Effect.fn('task.diffMergeRequest')(function* (
  flags: readonly string[],
) {
  const { mergeRequestIid, targetBranch } = yield* readMergeRequest();
  return { mergeRequestIid, output: yield* gitDiff(targetBranch, flags) };
});

/** The run's merge request's diff, and the files it changes, whose languages pick the principles. */
const readMergeRequestChanges = Effect.fn('task.readMergeRequestChanges')(function* () {
  const { mergeRequestIid, targetBranch } = yield* readMergeRequest();
  const diff = yield* gitDiff(targetBranch, []);
  const files = yield* changedFiles(targetBranch);
  return { mergeRequestIid, diff, files };
});

/** The files the merge request changes. */
export const changedFiles = Effect.fn('task.changedFiles')(function* (targetBranch: string) {
  const names = yield* gitDiff(targetBranch, ['--name-only', '-z']);
  return names.split('\0').filter(file => file !== '');
});

/**
 * Note the untracked files before the rewrite agent runs, so `verify rewrite` deletes only the
 * ones it creates. The retry keeps the first snapshot: its agent works on the same rewrite.
 */
const snapshotUntracked = Effect.fn('task.snapshotUntracked')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const changes = yield* listWorkingTreeChanges().pipe(
    Effect.mapError(error => userError(error, `can't list the untracked files: ${error.message}`)),
  );
  const snapshot = changes
    .filter(({ isUntracked }) => isUntracked)
    .map(({ path }) => `${path}\0`)
    .join('');
  yield* fs.writeFileString(REWRITE_STATE_FILES.untrackedBefore, snapshot).pipe(Effect.orDie);
});

/**
 * The principles a round's confirm and challenge cards test. A round doesn't need them: a project
 * without a readable doc gets none (the learn run says why), and a doc edited out of shape has none
 * until the learn run converts it back.
 */
const principlesToTest = Effect.fn('task.principlesToTest')(function* () {
  const current = yield* readCurrentPrinciplesDoc().pipe(Effect.option);
  return Option.isSome(current) && current.value._tag === 'Parsed' ? current.value.principles : [];
});

/**
 * The questions the project's cards have tested, whose ids the round's cards reuse, and whose ages
 * rest some of them. A round doesn't need them either: when codetinder.dev can't answer, the round
 * goes ahead without, held to no freshness budget, and a failure that lasts (no ID token,
 * codetinder.dev down) still reaches the MR as the round's upload fails and its note says why.
 */
const questionsToReuse = Effect.fn('task.questionsToReuse')(
  function* () {
    const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
    const codetinder = yield* CodeTinder;
    const { questions } = yield* codetinder.getQuestions(projectId);
    return Option.some(questions);
  },
  Effect.provide(CodeTinder.layer),
  // A stalled connection must not hold the step to its 120-second limit, losing the round.
  Effect.timeout(CODETINDER_READ_TIMEOUT),
  // ponytail: without a log line, since the flow's router matches this step's whole output,
  // stderr included: one more line would end the run without its agent.
  Effect.orElseSucceed(() => Option.none()),
  Effect.catchDefect(() => Effect.succeed(Option.none())),
);

/** The tail of the tests' output on the rewrite a retry fixes. */
const readPreviousFailure = Effect.fn('task.readPreviousFailure')(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(REWRITE_STATE_FILES.testOutput)
    .pipe(
      Effect.mapError(error =>
        userError(
          error,
          `no failed rewrite to retry: can't read ${REWRITE_STATE_FILES.testOutput}`,
        ),
      ),
    );
});

/**
 * A sweep's tasks: finding the functions in the code changed since the last sweep, then rewriting
 * the ones `sweep pick` kept.
 */
const runSweepTask = Effect.fn('task.runSweepTask')(function* (
  step: 'sweep' | 'sweep-rewrite' | 'sweep-rewrite-retry',
) {
  const principles = yield* readPrinciples();
  if (step === 'sweep') {
    const { base, carryOver } = yield* readSweepRun();
    const changedCode = parseChangedCode(yield* diffSince(base, ['-U0']));
    return renderTask(sweepTask({ principles, changedCode, carryOver }));
  }
  const { kept } = yield* readSweepPicks();
  if (step === 'sweep-rewrite') {
    yield* snapshotUntracked();
    return renderTask(sweepRewriteTask({ functions: kept, principles }));
  }
  const previousFailure = yield* readPreviousFailure();
  return renderTask(sweepRewriteTask({ functions: kept, principles, previousFailure }));
});

const isRetry = (step: TaskStep) => step === 'rewrite-retry' || step === 'sweep-rewrite-retry';

/** A correction: the generate or sweep agent's task. */
const isCorrection = (step: TaskStep) => step === 'generate-retry' || step === 'sweep-retry';

/**
 * The task again, with the answer `round` or `sweep pick` rejected and why, for the agent to
 * correct.
 */
const runCorrectionTask = Effect.fn('task.runCorrectionTask')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const correction = yield* fs.readFileString(CORRECTION_STATE_FILE).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(AnswerCorrectionSchema))),
    Effect.mapError(error =>
      userError(error, `no answer to correct: can't read ${CORRECTION_STATE_FILE}`),
    ),
  );
  return correctionTask(correction);
});

export const runTask = Effect.fn('task.run')(function* (step: TaskStep) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // A rewrite that failed for the sandbox would fail again: no retry, straight on to the proposal.
  if (isRetry(step) && (yield* fs.exists(REWRITE_STATE_FILES.environment).pipe(Effect.orDie))) {
    yield* Console.log('no retry: the install or tests fail in the sandbox before any change');
    return;
  }

  const content: string = yield* Effect.gen(function* () {
    if (isCorrection(step)) return yield* runCorrectionTask();
    if (step === 'learn') {
      return yield* runLearnTask().pipe(Effect.provide(CodeTinder.layer));
    }
    if (step === 'sweep' || step === 'sweep-rewrite' || step === 'sweep-rewrite-retry') {
      return yield* runSweepTask(step);
    }

    const { mergeRequestIid, diff, files } = yield* readMergeRequestChanges();

    if (step === 'generate') {
      const principles = yield* principlesToTest();
      const questions = yield* questionsToReuse();
      // One reading serves the task, the checks of the answer and those of its correction.
      if (Option.isSome(questions)) yield* writeQuestionsSnapshot(questions.value);
      return renderTask(
        generateTask({
          mergeRequestIid,
          diff,
          mergeRequestFiles: files,
          principles,
          questions: Option.getOrElse(questions, () => []),
        }),
      );
    }

    const principles = yield* readPrinciples();
    if (step === 'rewrite') {
      yield* snapshotUntracked();
      return renderTask(
        rewriteTask({ mergeRequestIid, diff, mergeRequestFiles: files, principles }),
      );
    }

    const previousFailure = yield* readPreviousFailure();
    return renderTask(
      rewriteTask({
        mergeRequestIid,
        diff,
        mergeRequestFiles: files,
        principles,
        previousFailure,
      }),
    );
  });

  yield* fs.makeDirectory(path.dirname(TASK_FILE), { recursive: true }).pipe(Effect.orDie);
  yield* fs.writeFileString(TASK_FILE, content).pipe(Effect.orDie);
  yield* Console.log(`wrote ${TASK_FILE}`);
});

export const taskCommand = Command.make(
  'task',
  {
    step: Argument.Literals('step', TaskStepSchema.literals).pipe(
      Argument.withDescription(
        'The LLM step: generate, generate-retry, learn, rewrite, rewrite-retry, sweep, sweep-retry, sweep-rewrite or sweep-rewrite-retry',
      ),
    ),
  },
  ({ step }) => runTask(step).pipe(Effect.provide(GitLabMergeRequests.layer)),
).pipe(
  Command.withDescription(
    'Write the task and answer schema for an LLM step to .codetinder/task.md',
  ),
);
