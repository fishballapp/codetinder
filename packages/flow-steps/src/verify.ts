import {
  assignCardIds,
  countEligible,
  decodeGenerateAnswer,
  diagnoseFailure,
  type EnvironmentFailure,
  EnvironmentFailureSchema,
  failed,
  formatVerdict,
  freshnessShortfall,
  isRewritable,
  LEARN_RUN_FILES,
  locateSnippet,
  MIN_ROUND_CARDS,
  oneLine,
  PRINCIPLES_PATH,
  PROJECT_CONFIG_PATH,
  REST_ROUNDS,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  ROUND_RUN_FILES,
  type Round,
  type RoundAnswer,
  type Snippet,
  SnippetNotFoundError,
  SWEEP_RUN_FILES,
  stripCodeFence,
  swapSnippet,
  verified,
  type WorkingTreeChange,
  withinFreshnessBudget,
} from '@codetinder/core';
import { GitLabMergeRequests } from '@codetinder/gitlab';
import * as Clock from 'effect/Clock';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { type Rejected, rejected } from './correction';
import { projectCommands } from './project-commands';
import { readProjectConfig } from './project-config-file';
import { readQuestionsSnapshot } from './questions-snapshot';
import { logSession } from './session-log';
import { git, listWorkingTreeChanges, runShell } from './shell';
import { readSweepPicks } from './sweep-run';
import { diffMergeRequest, TASK_FILE } from './task';
import { cardLabel, type FailedCard, type NumberedCard, numberCards, typecheck } from './typecheck';

const locateInFile = Effect.fn('verify.locateInFile')(function* (snippet: Snippet) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(snippet.file).pipe(Effect.option);
  if (Option.isNone(text)) {
    return Result.fail(
      new SnippetNotFoundError({
        file: snippet.file,
        message: `not in ${snippet.file}, which does not exist`,
      }),
    );
  }
  return locateSnippet(text.value, snippet);
});

/** Why the pick fails, if it does: the function and each context snippet, once in its file. */
const checkPick = Effect.fn('verify.checkPick')(function* (answer: RoundAnswer) {
  const snippets = [
    { label: 'the function', snippet: answer.target },
    ...answer.context.map(snippet => ({ label: snippet.symbol, snippet })),
  ];
  const located = yield* Effect.forEach(
    snippets,
    ({ label, snippet }) => locateInFile(snippet).pipe(Effect.map(result => ({ label, result }))),
    { concurrency: 'unbounded' },
  );
  const failure = located.find(({ result }) => Result.isFailure(result));
  if (failure === undefined || Result.isSuccess(failure.result)) return Option.none();
  return Option.some(`${failure.label} is ${failure.result.failure.message}`);
});

const testCard = Effect.fn('verify.testCard')(function* ({
  target,
  originalText,
  numbered,
  testCommand,
}: {
  readonly target: Snippet;
  readonly originalText: string;
  readonly numbered: NumberedCard;
  readonly testCommand: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.acquireUseRelease(
    Effect.gen(function* () {
      const swapped = yield* Effect.fromResult(
        swapSnippet(originalText, target, numbered.card.after),
      );
      yield* fs.writeFileString(target.file, swapped);
      return originalText;
    }).pipe(Effect.orDie),
    () =>
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        const { exitCode } = yield* runShell(testCommand);
        const ended = yield* Clock.currentTimeMillis;
        yield* Console.error(`${cardLabel(numbered)}: exit ${exitCode} in ${ended - started}ms`);
        return exitCode;
      }),
    text => fs.writeFileString(target.file, text).pipe(Effect.orDie),
  );
});

const runTests = Effect.fn('verify.runTests')(function* ({
  target,
  cards,
  testCommand,
  originalText,
}: {
  readonly target: Snippet;
  readonly cards: readonly NumberedCard[];
  readonly testCommand: string;
  readonly originalText: string;
}) {
  const results = yield* Effect.forEach(
    cards,
    numbered =>
      testCard({
        target,
        originalText,
        numbered,
        testCommand,
      }).pipe(Effect.map(exitCode => ({ numbered, exitCode }))),
    { concurrency: 1 },
  );
  return results.filter(({ exitCode }) => exitCode === 0).map(({ numbered }) => numbered);
});

export type VerifyRoundOutcome =
  | {
      readonly _tag: 'Verified';
      readonly round: Round;
      /**
       * How many of the round's cards ask a question outside the project's latest judged rounds;
       * absent when the questions couldn't be read.
       */
      readonly eligibleCards?: number;
    }
  | {
      readonly _tag: 'Skipped';
      readonly reason: string;
      readonly environment?: EnvironmentFailure;
    }
  | Rejected;

const skipped = (reason: string): VerifyRoundOutcome => ({
  _tag: 'Skipped',
  reason,
});

const freshnessRejection = (shortfall: Parameters<typeof freshnessShortfall>[0]) =>
  rejected(
    `only ${shortfall.kept.length} card(s) are left once the questions judged in the project's last ${REST_ROUNDS} judged rounds rest, and a round needs ${MIN_ROUND_CARDS}`,
    freshnessShortfall(shortfall),
  );

/** Each card that failed the typecheck, by its number and operation, with tsc's errors. */
const describeFailedCards = (failedCards: readonly FailedCard[]): string =>
  failedCards
    .map(({ numbered, errors }) => `${cardLabel(numbered)}:\n${errors.join('\n')}`)
    .join('\n\n');

/** The verdict's reason for a stage that failed before any change: the sandbox, not the change. */
const STAGE_FAILURE = {
  install: 'the install fails in the sandbox before any change',
  tests: 'the tests fail in the sandbox before any change',
} as const;

/** A stage whose command failed: what ran, how it ended and what it printed, so the note can show it. */
const environmentFailure = (
  stage: EnvironmentFailure['stage'],
  command: string,
  { exitCode, outputTail }: { readonly exitCode: number; readonly outputTail: string },
): EnvironmentFailure => ({
  stage,
  diagnosis: diagnoseFailure(outputTail),
  outputTail,
  command,
  exitCode,
});

const environmentSkip = (environment: EnvironmentFailure) =>
  ({
    _tag: 'Skipped',
    reason: STAGE_FAILURE[environment.stage],
    environment,
  }) satisfies VerifyRoundOutcome;

/**
 * A check step's own deadline, short of the 30 minutes the flow gives the step (`timeout: "1800"` in
 * packages/flows/codetinder.yml): a check that runs long is stopped here, its command with it, and still
 * ends in a note instead of being cut off silently.
 */
const CHECK_DEADLINE = Duration.minutes(28);

/** A check stopped at its deadline. Mostly the tests running long; close enough to say so. */
const PAST_DEADLINE: EnvironmentFailure = {
  stage: 'tests',
  diagnosis: { _tag: 'TimedOut' },
  outputTail: '',
};

/** How much of the agent's reason for declining a note keeps: a sentence or two. */
const MAX_DECLINE_REASON = 300;

/**
 * The whole sentences of `text` that fit in `max` characters, so a note never shows one broken
 * off. A first sentence longer than that is cut at a word and ends in an ellipsis.
 */
const clipToSentences = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const sentenceEnds = text.slice(0, max + 1).matchAll(/[.!?](?=\s)/g);
  const lastSentenceEnd = [...sentenceEnds].at(-1)?.index;
  if (lastSentenceEnd !== undefined) return text.slice(0, lastSentenceEnd + 1);
  const lastSpace = text.lastIndexOf(' ', max - 1);
  const cut = lastSpace > 0 ? lastSpace : max - 1;
  const trailingSeparators = /[\s,;:]+$/;
  return `${text.slice(0, cut).replace(trailingSeparators, '')}…`;
};

export const verifyRound = Effect.fn('verify.round')(
  function* (answerFile: string) {
    const fs = yield* FileSystem.FileSystem;

    const exists = yield* fs.exists(answerFile).pipe(Effect.orDie);
    if (!exists) {
      return skipped('the agent gave no answer');
    }

    const answerText = yield* fs.readFileString(answerFile).pipe(Effect.result);
    if (Result.isFailure(answerText)) {
      return skipped(`can't read the answer: ${oneLine(answerText.failure.message)}`);
    }
    const decoded = decodeGenerateAnswer(stripCodeFence(answerText.success));
    if (Result.isFailure(decoded)) {
      return rejected(
        `the answer is invalid: ${oneLine(decoded.failure.message)}`,
        decoded.failure.message,
      );
    }
    const answer = decoded.success;
    if ('declined' in answer) {
      const reason = oneLine(answer.declined);
      return skipped(clipToSentences(reason, MAX_DECLINE_REASON));
    }

    const pickFailure = yield* checkPick(answer);
    if (Option.isSome(pickFailure)) return rejected(pickFailure.value);
    yield* logSession(
      `The agent picked \`${answer.target.symbol}\` in ${answer.target.file}: ${oneLine(answer.reason)}`,
    );

    // An answer the freshness budget leaves too few cards is rejected before the install and the
    // tests, to save their work. The budget trims only the cards that pass them: trimmed first, a
    // card the tests then drop could leave too few where the whole deck had enough.
    const history = yield* readQuestionsSnapshot();
    const questions = Option.getOrElse(history, () => []);
    const { kept: freshCards } = withinFreshnessBudget(answer.cards, questions);
    if (freshCards.length < MIN_ROUND_CARDS) {
      return freshnessRejection({ cards: answer.cards, kept: freshCards, questions });
    }

    const config = yield* readProjectConfig();
    if (config._tag === 'Missing') return skipped(`this project has no ${PROJECT_CONFIG_PATH}`);
    if (config._tag === 'Invalid') {
      return skipped(`${PROJECT_CONFIG_PATH} is invalid: ${oneLine(config.message)}`);
    }

    const commands = yield* projectCommands(config.config);
    const install = yield* runShell(commands.install);
    if (install.exitCode !== 0) {
      return environmentSkip(environmentFailure('install', commands.install, install));
    }

    const originalText = yield* fs.readFileString(answer.target.file).pipe(Effect.orDie);

    const typechecked = yield* typecheck(answer);
    if (typechecked._tag === 'Skipped') return skipped(typechecked.reason);
    if (typechecked._tag === 'Rejected') {
      return rejected(typechecked.reason, typechecked.errors.join('\n'));
    }
    if (typechecked._tag === 'Unchecked') {
      yield* Console.error(`typecheck skipped: ${typechecked.reason}`);
    }
    if (typechecked._tag === 'Checked') {
      yield* logSession(
        `Typechecked ${answer.cards.length} variants: ${typechecked.cards.length} passed, ${typechecked.failed.length} dropped`,
      );
    }
    // Too few cards to make a round is the answer's fault, and known before the tests run.
    if (typechecked._tag === 'Checked' && typechecked.cards.length < MIN_ROUND_CARDS) {
      return rejected(
        `only ${typechecked.cards.length} card(s) passed the typecheck, and a round needs ${MIN_ROUND_CARDS}`,
        describeFailedCards(typechecked.failed),
      );
    }
    const afterTypecheck =
      typechecked._tag === 'Checked' ? typechecked.cards : numberCards(answer.cards);

    const afterTests = yield* runTests({
      target: answer.target,
      cards: afterTypecheck,
      testCommand: commands.test,
      originalText,
    });
    yield* logSession(
      `Ran the project's tests on ${afterTypecheck.length} variants: ${afterTests.length} passed, ${afterTypecheck.length - afterTests.length} dropped`,
    );

    if (afterTests.length < MIN_ROUND_CARDS) {
      // The cards are to blame only if the tests pass on the code as it was.
      const baseline = yield* runShell(commands.test);
      if (baseline.exitCode !== 0) {
        return environmentSkip(environmentFailure('tests', commands.test, baseline));
      }
      return skipped(
        `only ${afterTests.length} card(s) passed the typecheck and tests, and a round needs ${MIN_ROUND_CARDS}`,
      );
    }

    const testedCards = afterTests.map(({ card }) => card);
    const { kept: finalCards } = withinFreshnessBudget(testedCards, questions);
    if (finalCards.length < MIN_ROUND_CARDS) {
      return freshnessRejection({ cards: testedCards, kept: finalCards, questions });
    }

    // A consistency card whose other half was dropped stays, unpaired: the round still works.
    return {
      _tag: 'Verified' as const,
      round: {
        version: 2 as const,
        target: answer.target,
        reason: answer.reason,
        context: answer.context,
        imports: answer.imports,
        cards: assignCardIds(finalCards),
      },
      ...(Option.isSome(history) ? { eligibleCards: countEligible(finalCards, questions) } : {}),
    };
  },
  Effect.timeoutOrElse({
    duration: CHECK_DEADLINE,
    orElse: () => Effect.succeed(environmentSkip(PAST_DEADLINE)),
  }),
);

/** The files the flow's steps leave in the repo for each other, which no scope reverts. */
const RUN_FILES: ReadonlySet<string> = new Set([
  TASK_FILE,
  ...Object.values(ROUND_RUN_FILES),
  ...Object.values(LEARN_RUN_FILES),
  ...Object.values(REWRITE_RUN_FILES),
  ...Object.values(SWEEP_RUN_FILES),
]);

/** Undo each change: restore a tracked file as committed, delete an untracked one. */
const revertAll = Effect.fn('verify.revertAll')(function* (
  changes: readonly WorkingTreeChange[],
  why: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    changes,
    ({ path, isUntracked }) =>
      Effect.gen(function* () {
        // ponytail: a change staged in the index (an added or renamed file) fails to restore and
        // fails the verdict; the flow's agents edit files but never stage them.
        yield* isUntracked
          ? fs.remove(path).pipe(Effect.orDie)
          : git(['checkout', 'HEAD', '--', path]);
        yield* Console.error(`reverted ${path}: ${why}`);
      }),
    // One at a time: git takes the index lock to restore a file.
    { concurrency: 1, discard: true },
  );
});

/**
 * Which changes may be reverted as the rewrite's: any tracked one, but an untracked file only if it
 * wasn't there before. The runner leaves untracked files of its own (`.bashrc`, `.gitconfig`, …).
 */
const readRevertPolicy = Effect.fn('verify.readRevertPolicy')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const snapshot = yield* fs
    .readFileString(REWRITE_STATE_FILES.untrackedBefore)
    .pipe(Effect.option);
  if (Option.isNone(snapshot)) {
    yield* Console.error(
      `no ${REWRITE_STATE_FILES.untrackedBefore}: keeping every untracked file, as the rewrite's can't be told apart`,
    );
    return (change: WorkingTreeChange) => !change.isUntracked;
  }
  const untrackedBefore = new Set(snapshot.value.split('\0').filter(path => path !== ''));
  return (change: WorkingTreeChange) => !change.isUntracked || !untrackedBefore.has(change.path);
});

/** The reason of a rewrite's verdict when the tests fail on it, not on the code before it. */
export const TESTS_FAILED = 'tests failed';

/** The rewrite failed: its verdict, with the failed command's output kept for the retry. */
const failedWithOutput = (reason: string, outputTail: string) =>
  Effect.flatMap(FileSystem.FileSystem, fs =>
    fs
      .writeFileString(REWRITE_STATE_FILES.testOutput, `${outputTail}\n`)
      .pipe(Effect.orDie, Effect.as(failed(reason))),
  );

/** The rewrite failed for the sandbox, not for itself: kept for `propose`, and no retry follows. */
const failedInEnvironment = Effect.fn('verify.failedInEnvironment')(function* (
  environment: EnvironmentFailure,
) {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(EnvironmentFailureSchema))(
    environment,
  ).pipe(Effect.orDie);
  yield* fs.writeFileString(REWRITE_STATE_FILES.environment, encoded).pipe(Effect.orDie);
  return yield* failedWithOutput(STAGE_FAILURE[environment.stage], environment.outputTail);
});

/**
 * What a rewrite may change: the files in its scope, and the files the run itself writes that it
 * keeps (learn's principles doc). Anything else it changed is reverted before the tests judge it.
 */
type RewriteScope = { readonly files: ReadonlySet<string>; readonly kept: ReadonlySet<string> };

/** A learn run's rewrite: the code its merge request changes, beside the doc `render` wrote. */
const learnScope = Effect.gen(function* () {
  const { output } = yield* diffMergeRequest(['--name-only', '-z']);
  return {
    files: new Set(output.split('\0').filter(file => file !== '')),
    kept: new Set([PRINCIPLES_PATH]),
  } satisfies RewriteScope;
});

/** A sweep's rewrite: the files of the functions `sweep pick` kept, and never the doc. */
const sweepScope = Effect.gen(function* () {
  const { kept } = yield* readSweepPicks();
  return { files: new Set(kept.map(({ file }) => file)), kept: new Set() } satisfies RewriteScope;
});

/**
 * Install and run the tests on the rewrite, after reverting every change it may not make: code
 * outside its scope, and CodeTinder's and GitLab's config, so the rewrite can't loosen the tests
 * that judge it. The files the run keeps and its own files stay.
 */
const verifyRewrite = Effect.fn('verify.verifyRewrite')(
  function* (run: 'learn' | 'sweep') {
    const fs = yield* FileSystem.FileSystem;
    // The retry is handed the output of this run's failed command, never an earlier run's.
    yield* fs.remove(REWRITE_STATE_FILES.testOutput, { force: true }).pipe(Effect.orDie);

    const changes = yield* listWorkingTreeChanges();
    const canRevert = yield* readRevertPolicy();
    const isConfig = (change: WorkingTreeChange) => change.path === PROJECT_CONFIG_PATH;
    // The config names the test command, so it is restored before it's read.
    yield* revertAll(
      changes.filter(change => isConfig(change) && canRevert(change)),
      "outside the rewrite's scope",
    );

    const config = yield* readProjectConfig();
    if (config._tag === 'Missing') return failed(`missing ${PROJECT_CONFIG_PATH}`);
    if (config._tag === 'Invalid') return failed(`invalid ${PROJECT_CONFIG_PATH}`);

    const scope = run === 'learn' ? yield* learnScope : yield* sweepScope;
    const isRunOwned = (file: string) => scope.kept.has(file) || RUN_FILES.has(file);
    const isInScope = (file: string) => isRewritable(file, scope.files) || isRunOwned(file);
    yield* revertAll(
      changes.filter(change => !isConfig(change) && !isInScope(change.path) && canRevert(change)),
      "outside the rewrite's scope",
    );

    // The rewrite can't change the install: its manifests and lockfiles are reverted above.
    const commands = yield* projectCommands(config.config);
    const installed = yield* runShell(commands.install);
    if (installed.exitCode !== 0) {
      return yield* failedInEnvironment(environmentFailure('install', commands.install, installed));
    }
    const tested = yield* runShell(commands.test);
    if (tested.exitCode === 0) {
      yield* fs
        .writeFileString(REWRITE_STATE_FILES.testCommand, `${config.config.test}\n`)
        .pipe(Effect.orDie);
      return verified;
    }
    // The retry is the rewrite's last try, so only a failure after it is checked against the code.
    const retried = yield* fs.exists(REWRITE_RUN_FILES.retryAnswer).pipe(Effect.orDie);
    if (!retried) return yield* failedWithOutput(TESTS_FAILED, tested.outputTail);

    // Back to the code as it was: the rewrite is undone, the run's own files stay.
    const changesNow = yield* listWorkingTreeChanges();
    yield* revertAll(
      changesNow.filter(change => !isRunOwned(change.path) && canRevert(change)),
      'undone to check the tests on the code without the rewrite',
    );
    // Read again: the rewrite's changes are undone, so the pins are the code's own.
    const baselineCommands = yield* projectCommands(config.config);
    const baseline = yield* runShell(baselineCommands.test);
    if (baseline.exitCode === 0) return yield* failedWithOutput(TESTS_FAILED, tested.outputTail);
    return yield* failedInEnvironment(environmentFailure('tests', baselineCommands.test, baseline));
  },
  Effect.catchTags({
    GitFailed: error => Effect.succeed(failed(`can't check the rewrite's scope: ${error.message}`)),
    UserError: error => Effect.succeed(failed(error.message)),
  }),
);

/** Verifies a learn run's or a sweep's rewrite, printing and keeping its verdict for the steps after. */
const runVerify = Effect.fn('verify.run')(function* (run: 'learn' | 'sweep') {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // A run that dies before its verdict leaves none, never the one before it.
  yield* fs.remove(REWRITE_STATE_FILES.verdict, { force: true }).pipe(Effect.orDie);
  yield* fs.remove(REWRITE_STATE_FILES.environment, { force: true }).pipe(Effect.orDie);
  yield* fs.remove(REWRITE_STATE_FILES.testCommand, { force: true }).pipe(Effect.orDie);
  const outcome = yield* verifyRewrite(run).pipe(
    Effect.timeoutOrElse({
      duration: CHECK_DEADLINE,
      orElse: () => failedInEnvironment(PAST_DEADLINE),
    }),
  );
  yield* logSession(
    outcome._tag === 'Verified'
      ? "The rewrite passed the project's tests"
      : `The rewrite didn't pass: ${oneLine(outcome.reason)}`,
  );
  const verdict = formatVerdict(outcome);
  // `propose` reads the last verdict, after the retry's if there was one.
  yield* fs
    .makeDirectory(path.dirname(REWRITE_STATE_FILES.verdict), { recursive: true })
    .pipe(Effect.orDie);
  yield* fs.writeFileString(REWRITE_STATE_FILES.verdict, `${verdict}\n`).pipe(Effect.orDie);
  yield* Console.log(verdict);
});

export const runVerifyRewrite = () => runVerify('learn');

export const runVerifySweep = () => runVerify('sweep');

const verifyRewriteCommand = Command.make('rewrite', {}, () =>
  runVerifyRewrite().pipe(Effect.provide(GitLabMergeRequests.layer)),
).pipe(
  Command.withDescription(
    "Revert what learn's rewrite may not change, then install and run the project's tests",
  ),
);

// The learn run's scope reads its merge request, so the layer is there for both.
const verifySweepCommand = Command.make('sweep', {}, () =>
  runVerifySweep().pipe(Effect.provide(GitLabMergeRequests.layer)),
).pipe(
  Command.withDescription(
    "Revert what a sweep's rewrite may not change, then install and run the project's tests",
  ),
);

export const verifyCommand = Command.make('verify').pipe(
  Command.withDescription('Verify a rewrite against the project tests'),
  Command.withSubcommands([verifyRewriteCommand, verifySweepCommand]),
);
