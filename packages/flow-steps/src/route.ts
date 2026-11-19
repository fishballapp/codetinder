import type { ClaimSuccess } from '@codetinder/api';
import {
  forkNote,
  type GenerateRoute,
  isNotCode,
  noCodeNote,
  silentSkip,
  skippedNote,
} from '@codetinder/core';
import { GitLabMergeRequests, GitLabSweeps } from '@codetinder/gitlab';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import { endClaim, NO_ID_TOKEN_REASON, type RunClaim, startRunClaim, writeRunClaim } from './claim';
import { CodeTinder, readServiceAccount } from './codetinder';
import { readRoute } from './goal';
import { reportLearn } from './learn-report';
import { postNote } from './note';
import { readProjectConfig } from './project-config-file';
import { logSession } from './session-log';
import { routeBranchPipeline } from './sweep-route';
import { changedFiles } from './task';

const readTone = Effect.fn('route.readTone')(function* () {
  const config = yield* readProjectConfig();
  return config._tag === 'Ok' ? config.config.tone : 'plain';
});

/** Why a run on a merge request ends here without a word on the MR, for the session log. */
const SILENT_SKIP_LINES = {
  closed: 'is closed',
  otherbranch: "isn't on the branch this pipeline ran on",
  codetinder: "is CodeTinder's own",
  draft: 'is a draft',
} as const;

/** Why the commit has no round from this run, for the session log. */
const CLAIM_SKIP_LINES = {
  Busy: "another run is making this commit's round",
  Tried: 'an earlier run gave up on this commit',
  HasRound: 'this commit already has its round',
} as const;

/** What codetinder.dev answered a claim, or why it couldn't be asked. */
type ClaimOutcome = ClaimSuccess | { readonly _tag: 'Refused'; readonly reason: string };

/**
 * The note of the latest developer's ask the run's round answers, which every session of one ask
 * reads alike: a mention's own, else the MR's latest request for CodeTinder's review, which any
 * round on the MR answers (its note finishes that review).
 */
const latestAsk = Effect.fn('route.latestAsk')(function* ({
  projectId,
  route,
}: {
  readonly projectId: string;
  readonly route: GenerateRoute;
}) {
  if (route.event === 'mention') return Option.some(route.noteId);
  const gitlab = yield* GitLabMergeRequests;
  return yield* gitlab.latestReviewRequest({
    projectId,
    mergeRequestIid: route.mergeRequestIid,
    reviewer: yield* readServiceAccount(),
  });
});

/** Claims the commit's round on codetinder.dev, before the agent that is billed per call. */
const claimCommit = Effect.fn('route.claimCommit')(function* ({
  projectId,
  route,
  runClaim,
}: {
  readonly projectId: string;
  readonly route: GenerateRoute;
  readonly runClaim: RunClaim;
}) {
  const refused = (error: { readonly message: string }) =>
    Effect.succeed<ClaimOutcome>({
      _tag: 'Refused',
      reason: `codetinder.dev refused the claim: ${error.message}`,
    });
  // ponytail: codetinder.dev down past the client's retries fails the step, and the run ends with
  // no note. Rare, and no round could be stored then either.
  return yield* Effect.gen(function* () {
    const codetinder = yield* CodeTinder;
    const askNoteId = yield* latestAsk({ projectId, route });
    return yield* codetinder.claim({
      mergeRequestIid: route.mergeRequestIid,
      headSha: runClaim.headSha,
      runId: runClaim.runId,
      event: route.event,
      ...(Option.isSome(askNoteId) ? { askNoteId: askNoteId.value } : {}),
    });
  }).pipe(
    Effect.provide(CodeTinder.layer),
    Effect.catchTags({
      ConfigError: () =>
        Effect.succeed<ClaimOutcome>({ _tag: 'Refused', reason: NO_ID_TOKEN_REASON }),
      Unauthorized: refused,
      Forbidden: refused,
    }),
  );
});

/**
 * Prints the route for the flow's router, or a word that matches no branch and so ends the run. A
 * pipeline on the default branch with no merge request is the sweep's: `sweep` or `nosweep`.
 * One note, then the word: `fork` for a merge request from a fork, whose code the flow never runs;
 * `nocode` for a round on one that changes no code, which has no function for the agent to pick;
 * `skipped` when codetinder.dev can't be asked for the commit. Silently: a pipeline on a branch
 * with no merge request (`nomergerequest`), core's `silentSkip`, and a commit whose round another
 * run is making (`busy`), an earlier run gave up on (`tried`) or that has its round (`hasround`).
 * Each run's round is for the commit it checked out, and only the run codetinder.dev gives that
 * commit to goes on: a developer's ask on a commit with a round replaces it.
 */
export const runRoute = Effect.fn('route.run')(function* () {
  const route = yield* readRoute();
  if (route._tag === 'nomergerequest') {
    const branchRoute = yield* routeBranchPipeline(route.pipeline);
    if (branchRoute === 'sweep') yield* logSession('Started a sweep of the default branch.');
    if (branchRoute === 'nomergerequest') {
      yield* logSession('Skipped: this pipeline is on a branch with no merge request.');
    }
    yield* Console.log(branchRoute);
    return;
  }

  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  const { mergeRequestIid } = route;
  const gitlab = yield* GitLabMergeRequests;
  const mergeRequest = yield* gitlab.get({ projectId, mergeRequestIid });
  // A deleted fork leaves no source project: its branch can't be checked here either.
  const isFork = mergeRequest.sourceProjectId !== mergeRequest.targetProjectId;

  if (isFork) {
    yield* postNote({ projectId, mergeRequestIid, body: forkNote({ tone: yield* readTone() }) });
    yield* logSession(
      `Skipped: !${mergeRequestIid} comes from a fork, whose code CodeTinder never runs. Posted a comment saying so.`,
    );
    yield* Console.log('fork');
    return;
  }

  if (route._tag === 'learn') {
    yield* reportLearn({ roundId: route.roundId, noteId: route.noteId, report: 'Started' });
    yield* logSession(`Started learning from your swipes on !${mergeRequestIid}'s round.`);
    yield* Console.log(route._tag);
    return;
  }

  const skip = silentSkip(route, mergeRequest);
  if (skip !== undefined) {
    yield* logSession(`Skipped: !${mergeRequestIid} ${SILENT_SKIP_LINES[skip]}.`);
    yield* Console.log(skip);
    return;
  }

  const runClaim = yield* startRunClaim();
  const claim = yield* claimCommit({ projectId, route, runClaim });
  if (claim._tag === 'Refused') {
    const body = skippedNote({ tone: yield* readTone(), reason: claim.reason });
    yield* postNote({ projectId, mergeRequestIid, body });
    yield* logSession(`Skipped: ${claim.reason}. Posted a comment saying why.`);
    yield* Console.log('skipped');
    return;
  }
  if (claim._tag !== 'Claimed') {
    yield* logSession(`Skipped: ${CLAIM_SKIP_LINES[claim._tag]}.`);
    yield* Console.log(claim._tag.toLowerCase());
    return;
  }
  if (claim.replacedRoundId !== undefined) {
    yield* writeRunClaim({ ...runClaim, replacedRoundId: claim.replacedRoundId });
  }

  // Where git can't say what changed, the task reports why; this only skips what is certain.
  const files = yield* changedFiles(mergeRequest.targetBranch).pipe(
    Effect.option,
    Effect.map(Option.getOrElse((): readonly string[] => [])),
  );
  const hasOnlyNonCode = files.length > 0 && files.every(isNotCode);
  if (!hasOnlyNonCode) {
    yield* logSession(
      `Started a round for !${mergeRequestIid} at commit ${runClaim.headSha.slice(0, 8)}.`,
    );
    yield* Console.log(route._tag);
    return;
  }

  const body = noCodeNote({ tone: yield* readTone(), files });
  yield* endClaim({ mergeRequestIid, claim: runClaim });
  yield* postNote({ projectId, mergeRequestIid, body });
  yield* logSession(`Skipped: !${mergeRequestIid} changes no code. Posted a comment saying so.`);
  yield* Console.log('nocode');
});

export const routeCommand = Command.make('route', {}, () =>
  runRoute().pipe(Effect.provide(Layer.mergeAll(GitLabMergeRequests.layer, GitLabSweeps.layer))),
).pipe(
  Command.withDescription(
    'Print generate, learn or sweep for the flow router, or a word that ends the run',
  ),
);
