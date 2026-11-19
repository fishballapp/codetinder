import {
  formatVerdict,
  oneLine,
  roundNote,
  type SandboxFixMergeRequest,
  skippedNote,
} from '@codetinder/core';
import { GitLabCommits, GitLabFiles, GitLabMergeRequests, GitLabSetup } from '@codetinder/gitlab';
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
import { endClaim, NO_ID_TOKEN_REASON, type RunClaim, readRunClaim } from './claim';
import { CodeTinder } from './codetinder';
import { handOverForCorrection } from './correction';
import { readGenerateRoute } from './goal';
import { postNote } from './note';
import { readProjectConfig } from './project-config-file';
import { removeQuestionsSnapshot } from './questions-snapshot';
import { proposeSandboxFix } from './sandbox-fix';
import { logSession } from './session-log';
import { TASK_FILE } from './task';
import { type RoundOutcome, skipped, uploadRound } from './upload';
import { messageOf } from './user-error';
import { verifyRound } from './verify';

const removeRunFiles = (answerFile: string) =>
  Effect.flatMap(FileSystem.FileSystem, fs =>
    Effect.forEach([TASK_FILE, answerFile], file => fs.remove(file).pipe(Effect.ignore), {
      discard: true,
    }),
  );

const makeRound = (answerFile: string, mergeRequestIid: number, claim: RunClaim) =>
  Effect.gen(function* () {
    const verified = yield* verifyRound(answerFile);
    if (verified._tag !== 'Verified') {
      return verified;
    }
    // The client is built only here: without the ID token, the run still ends in a note.
    return yield* uploadRound({
      mergeRequestIid,
      claim,
      round: verified.round,
      eligibleCards: verified.eligibleCards,
    }).pipe(
      Effect.provide(CodeTinder.layer),
      Effect.catchTag('ConfigError', () => Effect.succeed(skipped(NO_ID_TOKEN_REASON))),
    );
  }).pipe(
    Effect.catchDefect(defect =>
      Effect.succeed(skipped(`CodeTinder hit an unexpected error: ${oneLine(messageOf(defect))}`)),
    ),
  );

const noteFor = (
  tone: 'mischievous' | 'plain',
  outcome: RoundOutcome,
  claim: RunClaim,
  sandboxFix: SandboxFixMergeRequest | undefined,
): string =>
  outcome._tag === 'Uploaded'
    ? roundNote({
        tone,
        round: outcome.round,
        url: outcome.url,
        serviceAccount: outcome.serviceAccount,
        isFresh: claim.replacedRoundId !== undefined,
        eligibleCards: outcome.eligibleCards,
      })
    : skippedNote({ tone, reason: outcome.reason, environment: outcome.environment, sandboxFix });

const endRound = Effect.fn('round.end')(function* ({
  projectId,
  mergeRequestIid,
  claim,
  made,
}: {
  readonly projectId: string;
  readonly mergeRequestIid: number;
  readonly claim: RunClaim;
  readonly made: Effect.Success<ReturnType<typeof makeRound>>;
}) {
  const outcome: RoundOutcome = made._tag === 'Rejected' ? skipped(made.reason) : made;
  // A round stored is recorded on the claim; one that wasn't gives the commit up for a retry.
  if (outcome._tag === 'Skipped') {
    yield* endClaim({ mergeRequestIid, claim });
  }
  // A sandbox that failed the project's install or tests gets an MR that fixes it, when one can.
  const sandboxFix =
    outcome._tag === 'Skipped' && outcome.environment !== undefined
      ? Option.getOrUndefined(yield* proposeSandboxFix(outcome.environment))
      : undefined;

  const config = yield* readProjectConfig();
  const tone = config._tag === 'Ok' ? config.config.tone : 'plain';

  const noteResult = yield* postNote({
    projectId,
    mergeRequestIid,
    body: noteFor(tone, outcome, claim, sandboxFix),
  }).pipe(
    Effect.mapError(error => error.message),
    Effect.catchDefect(defect => Effect.fail(messageOf(defect))),
    Effect.result,
  );

  if (Result.isFailure(noteResult)) {
    yield* logSession(`Couldn't post the round's comment: ${oneLine(noteResult.failure)}`);
    yield* Console.log(`failed: couldn't post the note: ${oneLine(noteResult.failure)}`);
    return;
  }
  yield* logSession(
    outcome._tag === 'Uploaded'
      ? `Posted the round's comment: ${outcome.round.cards.length} variants to swipe at ${outcome.url}`
      : `No round: ${oneLine(outcome.reason)}. Posted a comment saying why`,
  );
  if (sandboxFix !== undefined) {
    yield* logSession(
      sandboxFix.isNew
        ? `Opened !${sandboxFix.iid} to fix the sandbox`
        : `The sandbox's fix is in !${sandboxFix.iid}`,
    );
  }

  yield* Console.log(
    formatVerdict(
      outcome._tag === 'Uploaded'
        ? { _tag: 'Verified' }
        : { _tag: 'Skipped', reason: outcome.reason },
    ),
  );
});

/**
 * Checks the agent's answer and ends the round: stores it and posts its note, or posts why there
 * is none. With `canCorrect`, an answer that fails a check the agent can correct ends nothing yet:
 * it prints `correct` for the flow to hand the agent the error, and the next `round` decides.
 */
export const runRound = Effect.fn('round.run')(function* (
  answerFile: string,
  { canCorrect }: { readonly canCorrect: boolean },
) {
  return yield* Effect.gen(function* () {
    const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
    const { mergeRequestIid } = yield* readGenerateRoute();
    // The commit `route` claimed, and the run's id that claimed it.
    const claim = yield* readRunClaim();

    const made = yield* makeRound(answerFile, mergeRequestIid, claim);
    if (
      made._tag === 'Rejected' &&
      canCorrect &&
      (yield* handOverForCorrection(answerFile, made))
    ) {
      // The correction's round checks the new answer against the same questions.
      return;
    }
    // The questions outlive the first check for the correction's, and no further.
    yield* endRound({ projectId, mergeRequestIid, claim, made }).pipe(
      Effect.ensuring(removeQuestionsSnapshot()),
    );
  }).pipe(Effect.ensuring(removeRunFiles(answerFile)));
});

export const roundCommand = Command.make(
  'round',
  {
    answerFile: Argument.String('answer-file').pipe(
      Argument.withDescription("The generate step's answer, a JSON file"),
    ),
    canCorrect: Flag.Boolean('can-correct').pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        'On an answer the agent can correct, print `correct` and keep the error for `task generate-retry`, instead of ending the round',
      ),
    ),
  },
  ({ answerFile, canCorrect }) =>
    runRound(answerFile, { canCorrect }).pipe(
      Effect.provide(
        Layer.mergeAll(
          GitLabMergeRequests.layer,
          GitLabCommits.layer,
          GitLabSetup.layer,
          GitLabFiles.layer,
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    'Verify, upload, and announce a generate round, then clean up ephemeral files',
  ),
);
