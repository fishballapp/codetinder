import { CommitShaSchema, RoundIdSchema, RunIdSchema } from '@codetinder/api';
import { oneLine } from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { CodeTinder } from './codetinder';
import { runCapturingStdout } from './shell';
import { messageOf, userError } from './user-error';

/**
 * The commit the run checked out, which its round is for: the branch's tip when the run cloned,
 * which can be newer than the commit whose event started the run.
 */
const readHeadSha = Effect.fn('claim.readHeadSha')(function* () {
  const git = yield* runCapturingStdout('git', ['rev-parse', 'HEAD']);
  if (git.exitCode !== 0) {
    return yield* userError({
      message: `can't read the checked-out commit: git exited ${git.exitCode}`,
    });
  }
  return git.stdout.trim();
});

/**
 * Where `route` leaves the run's claim for `round`: in `/tmp/codetinder/`, out of the agent's
 * reach and never in the checkout, like everything flow-steps keeps for a later step.
 */
export const CLAIM_FILE = '/tmp/codetinder/claim.json';

/**
 * The commit a run claims, and the run's own id, which makes its requests about it its own; once
 * claimed, the round its round replaces as the commit's, when it had one.
 */
const RunClaimSchema = Schema.Struct({
  headSha: CommitShaSchema,
  runId: RunIdSchema,
  replacedRoundId: Schema.optionalKey(RoundIdSchema),
});
export type RunClaim = typeof RunClaimSchema.Type;

/** Writes down the run's claim, for every later request of the run and the round's note. */
export const writeRunClaim = Effect.fn('claim.write')(function* (claim: RunClaim) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* Schema.encodeEffect(Schema.fromJsonString(RunClaimSchema))(claim).pipe(
    Effect.orDie,
  );
  yield* fs.makeDirectory(path.dirname(CLAIM_FILE), { recursive: true }).pipe(Effect.orDie);
  yield* fs.writeFileString(CLAIM_FILE, text).pipe(Effect.orDie);
});

/**
 * Starts the run's claim: the checked-out commit and a fresh run id, written down before the
 * claim is sent, so every later request of the run, and every retry of one, names the same run.
 */
export const startRunClaim = Effect.fn('claim.start')(function* () {
  const claim: RunClaim = { headSha: yield* readHeadSha(), runId: crypto.randomUUID() };
  yield* writeRunClaim(claim);
  return claim;
});

/** The claim `route` started, which the run's round is stored under. */
export const readRunClaim = Effect.fn('claim.read')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(CLAIM_FILE)
    .pipe(Effect.mapError(error => userError(error, `the run has no claim: ${error.message}`)));
  return yield* Schema.decodeEffect(Schema.fromJsonString(RunClaimSchema))(text).pipe(
    Effect.mapError(error => userError(error, `the run's claim doesn't parse: ${error.message}`)),
  );
});

/**
 * Gives up the run's claim on its commit after an attempt that made no round, so a reviewer's
 * request can retry it. Never fails: if it can't, the claim times out on its own.
 */
export const endClaim = Effect.fn('claim.end')(function* ({
  mergeRequestIid,
  claim,
}: {
  readonly mergeRequestIid: number;
  readonly claim: RunClaim;
}) {
  // On stderr: stdout's last line is the step's verdict, which the flow's router reads.
  const unended = (failure: unknown) =>
    Console.error(`couldn't give up the claim: ${oneLine(messageOf(failure))}`);
  yield* Effect.gen(function* () {
    const codetinder = yield* CodeTinder;
    yield* codetinder.endClaim({ mergeRequestIid, headSha: claim.headSha, runId: claim.runId });
  }).pipe(Effect.provide(CodeTinder.layer), Effect.catch(unended), Effect.catchDefect(unended));
});

/** The reason a round can't reach codetinder.dev without the ID token, the same in every note. */
export const NO_ID_TOKEN_REASON =
  "this project's .gitlab/duo/agent-config.yml doesn't give the flow the CODETINDER_ID_TOKEN ID token";
