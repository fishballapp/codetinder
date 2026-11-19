import { RoundIdSchema } from '@codetinder/api';
import {
  applyWrittenRuleEdits,
  type CurrentPrinciples,
  type Delivery,
  diffPrinciples,
  EnvironmentFailureSchema,
  isRewritable,
  LEARN_RUN_FILES,
  LEARN_STATE_FILES,
  LearnAnswerSchema,
  LearnedSchema,
  type LearnOutcome,
  learnNote,
  oneLine,
  PRINCIPLES_PATH,
  type PrinciplesUpdate,
  type ProjectConfig,
  proposalCommitMessage,
  proposalDescription,
  proposalTitle,
  REWRITE_RUN_FILES,
  REWRITE_STATE_FILES,
  RewriteAnswerSchema,
  type RewriteOutcome,
  readCurrentPrinciples,
  renderPrinciplesDoc,
  rulesOf,
  type SkippedOperation,
  stripCodeFence,
  type WrittenRuleEdit,
  type WrittenRulesFile,
  type WrittenRuleUpdate,
} from '@codetinder/core';
import {
  type GitLabCommitFile,
  GitLabCommits,
  GitLabFiles,
  GitLabMergeRequests,
  type GitLabRequestFailed,
  GitLabSetup,
} from '@codetinder/gitlab';
import * as Clock from 'effect/Clock';
import * as Config from 'effect/Config';
import * as Console from 'effect/Console';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Layer from 'effect/Layer';
import * as Option from 'effect/Option';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { readRoute } from './goal';
import { reportLearn } from './learn-report';
import { readProjectConfig } from './project-config-file';
import { proposeSandboxFix } from './sandbox-fix';
import { logSession } from './session-log';
import { git, listWorkingTreeChanges, runCapturingStdout, runCapturingStdoutBytes } from './shell';
import { diffMergeRequest, TASK_FILE } from './task';
import { messageOf, userError } from './user-error';
import { TESTS_FAILED } from './verify';

type LearnRoute = { readonly mergeRequestIid: number; readonly roundId: string };

/** An agent's answer in `file`, decoded; none if the agent never saved one. */
const readAnswer = <A, I>(schema: Schema.Codec<A, I>, file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<A>();
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(
      stripCodeFence(text.value),
    ).pipe(Effect.mapError(error => userError(error, `${file} is invalid: ${error.message}`)));
    return Option.some(decoded);
  });

/**
 * The principles `render` wrote, from its copy outside the repo: the rewrite agent could have
 * edited the doc and the answer since. Without the copy, the answer says why render didn't run.
 */
const readLearned = Effect.fn('propose.readLearned')(function* () {
  const rendered = yield* readAnswer(LearnedSchema, LEARN_STATE_FILES.principles);
  if (Option.isSome(rendered)) return rendered.value;
  const answer = yield* readAnswer(LearnAnswerSchema, LEARN_RUN_FILES.principlesAnswer);
  if (Option.isNone(answer)) return yield* userError({ message: 'the agent gave no principles' });
  return yield* userError({ message: "the principles doc couldn't be written" });
});

/** The principles doc as the MR's branch has it, before this run: none if it isn't there yet. */
const readCommittedDoc = Effect.fn('propose.readCommittedDoc')(function* () {
  const shown = yield* runCapturingStdout('git', ['show', `HEAD:${PRINCIPLES_PATH}`]);
  if (shown.exitCode !== 0) return Option.none<{ text: string; current: CurrentPrinciples }>();
  const read = readCurrentPrinciples(shown.stdout);
  if (Result.isFailure(read)) {
    const { line, message } = read.failure;
    return yield* userError(read.failure, `${PRINCIPLES_PATH}:${line}: ${message}`);
  }
  return Option.some({ text: shown.stdout, current: read.success });
});

/** `bytes` as UTF-8 text, a byte order mark kept; none when they aren't valid UTF-8. */
const decodeUtf8 = (bytes: Uint8Array): string | undefined => {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/**
 * The learn agent's edits to the team's written rules, applied to each file as the MR's branch has
 * it. A file the proposal already commits (the principles doc, a file the rewrite changed) is left
 * alone: its edit is skipped.
 */
const editWrittenRules = Effect.fn('propose.editWrittenRules')(function* ({
  edits,
  principleIds,
  committed,
}: {
  readonly edits: readonly WrittenRuleEdit[];
  readonly principleIds: ReadonlySet<string>;
  readonly committed: ReadonlySet<string>;
}) {
  const paths = [...new Set(edits.map(({ path }) => path))].filter(path => !committed.has(path));
  const shown = yield* Effect.forEach(paths, path =>
    runCapturingStdoutBytes('git', ['show', `HEAD:${path}`]).pipe(
      Effect.map(({ exitCode, stdout }): (readonly [string, WrittenRulesFile])[] => {
        if (exitCode !== 0) return [];
        const content = decodeUtf8(stdout);
        return [[path, content === undefined ? { _tag: 'NotUtf8' } : { _tag: 'Text', content }]];
      }),
    ),
  );
  return applyWrittenRuleEdits({ edits, files: new Map(shown.flat()), principleIds });
});

/** What became of the rewrite, read from the last `verify rewrite` verdict. */
const readRewrite = Effect.fn('propose.readRewrite')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const verdict = yield* fs.readFileString(REWRITE_STATE_FILES.verdict).pipe(Effect.option);
  if (Option.isNone(verdict)) {
    return { _tag: 'Dropped', reason: "the rewrite didn't run" } satisfies RewriteOutcome;
  }
  const line = verdict.value.trim();
  if (line !== 'verified') {
    const reason = line.replace(/^failed: /, '');
    const environment = yield* readAnswer(
      EnvironmentFailureSchema,
      REWRITE_STATE_FILES.environment,
    );
    if (Option.isSome(environment)) {
      const sandboxFix = yield* proposeSandboxFix(environment.value);
      return {
        _tag: 'Dropped',
        reason,
        environment: environment.value,
        ...(Option.isSome(sandboxFix) ? { sandboxFix: sandboxFix.value } : {}),
      } satisfies RewriteOutcome;
    }
    return {
      _tag: 'Dropped',
      reason: reason === TESTS_FAILED ? 'the tests failed on it, twice' : reason,
    } satisfies RewriteOutcome;
  }

  // Only what the rewrite may change is proposed, whatever else the working tree holds; the doc is
  // proposed from the learned principles, never from the checkout.
  const mergeRequestFiles = new Set(
    (yield* diffMergeRequest(['--name-only', '-z'])).output.split('\0').filter(file => file !== ''),
  );
  const files = (yield* listWorkingTreeChanges())
    .filter(
      ({ path, isUntracked }) =>
        !isUntracked && path !== PRINCIPLES_PATH && isRewritable(path, mergeRequestFiles),
    )
    .map(({ path }) => path);
  if (files.length === 0) return { _tag: 'Unchanged' } satisfies RewriteOutcome;

  const retry = yield* readAnswer(RewriteAnswerSchema, REWRITE_RUN_FILES.retryAnswer);
  const answer = Option.isSome(retry)
    ? retry
    : yield* readAnswer(RewriteAnswerSchema, REWRITE_RUN_FILES.rewriteAnswer);
  // `verify` records the command only when it passes, so a verified rewrite always has one.
  const testCommand = yield* fs.readFileString(REWRITE_STATE_FILES.testCommand).pipe(Effect.option);
  if (Option.isNone(testCommand)) {
    return yield* userError({
      message: `the rewrite was verified, but ${REWRITE_STATE_FILES.testCommand} is missing`,
    });
  }
  return {
    _tag: 'Applied',
    summary: Option.match(answer, {
      onNone: () => 'Rewrote the changed code to follow the principles.',
      onSome: ({ summary }) => summary,
    }),
    files,
    testCommand: oneLine(testCommand.value),
  } satisfies RewriteOutcome;
});

/** Opens the proposal as an MR into the MR's branch, from a branch of its own. */
const openProposal = Effect.fn('propose.openProposal')(function* ({
  projectId,
  route,
  config,
  sourceBranch,
  head,
  message,
  principles,
  skipped,
  writtenRules,
  rewrite,
  files,
}: {
  readonly projectId: string;
  readonly route: LearnRoute;
  readonly config: ProjectConfig;
  readonly sourceBranch: string;
  readonly head: string;
  readonly message: string;
  readonly principles: PrinciplesUpdate;
  readonly skipped: readonly SkippedOperation[];
  readonly writtenRules: readonly WrittenRuleUpdate[];
  readonly rewrite: RewriteOutcome;
  readonly files: readonly GitLabCommitFile[];
}) {
  const mergeRequests = yield* GitLabMergeRequests;
  const commits = yield* GitLabCommits;
  const { mergeRequestIid, roundId } = route;
  // Each run its own branch: a teammate's Done after more swipes proposes again.
  const now = yield* Clock.currentTimeMillis;
  const branch = `codetinder/learn-${roundId}-${now.toString(36)}`;
  yield* commits.commit({ projectId, branch, startSha: head, message, files });
  const { iid } = yield* mergeRequests.createMergeRequest({
    projectId,
    sourceBranch: branch,
    targetBranch: sourceBranch,
    title: proposalTitle({ tone: config.tone, mergeRequestIid }),
    description: proposalDescription({
      tone: config.tone,
      mergeRequestIid,
      proposal: { principles, skipped, writtenRules, rewrite },
    }),
  });
  return iid;
});

/** Commits the proposal as the project's config says, onto the MR's branch or into an MR of its own. */
const deliver = Effect.fn('propose.deliver')(function* (args: {
  readonly projectId: string;
  readonly route: LearnRoute;
  readonly config: ProjectConfig;
  readonly principles: PrinciplesUpdate;
  readonly skipped: readonly SkippedOperation[];
  readonly writtenRules: readonly WrittenRuleUpdate[];
  readonly rewrite: RewriteOutcome;
  readonly files: readonly GitLabCommitFile[];
}) {
  const { projectId, route, config, principles, writtenRules, files } = args;
  const mergeRequests = yield* GitLabMergeRequests;
  const commits = yield* GitLabCommits;
  const { sourceBranch } = yield* mergeRequests.get({
    projectId,
    mergeRequestIid: route.mergeRequestIid,
  });
  const head = (yield* git(['rev-parse', 'HEAD'])).trim();
  const message = proposalCommitMessage({
    roundId: route.roundId,
    mergeRequestIid: route.mergeRequestIid,
    principles,
    writtenRules,
  });
  const proposal = { ...args, sourceBranch, head, message };

  if (config.proposal === 'merge-request') {
    return { _tag: 'MergeRequest', iid: yield* openProposal(proposal) } as const;
  }

  // Each file names the commit it was read at, so GitLab refuses the push if someone changed it
  // since, rather than overwrite their change: then it's an MR after all.
  const guarded = yield* Effect.forEach(files, file =>
    file.action === 'create'
      ? Effect.succeed(file)
      : git(['log', '-1', '--format=%H', 'HEAD', '--', file.path]).pipe(
          Effect.map(lastCommitId => ({ ...file, lastCommitId: lastCommitId.trim() })),
        ),
  );
  const pushed = yield* commits
    .commit({ projectId, branch: sourceBranch, message, files: guarded })
    .pipe(Effect.option);
  if (Option.isSome(pushed)) return { _tag: 'Pushed', commitUrl: pushed.value.webUrl } as const;
  return { _tag: 'MergeRequestInsteadOfPush', iid: yield* openProposal(proposal) } as const;
});

const learnOutcome = Effect.fn('propose.learnOutcome')(function* ({
  projectId,
  route,
  config,
}: {
  readonly projectId: string;
  readonly route: LearnRoute;
  readonly config: ProjectConfig;
}) {
  const fs = yield* FileSystem.FileSystem;

  const committed = yield* readCommittedDoc();
  const { principles: learned, skipped, writtenRuleEdits } = yield* readLearned();
  const principles = Option.match(committed, {
    onNone: (): PrinciplesUpdate => ({ _tag: 'Learned', changes: diffPrinciples([], learned) }),
    onSome: ({ current }): PrinciplesUpdate => {
      if (current._tag === 'Unconverted') {
        return { _tag: 'Converted', principles: learned };
      }
      const changes = diffPrinciples(current.principles, learned);
      return current.isNormalised ? { _tag: 'Learned', changes } : { _tag: 'Reformatted', changes };
    },
  });
  const rewrite = yield* readRewrite();
  const { updates: writtenRules, contents: writtenRuleContents } = yield* editWrittenRules({
    edits: writtenRuleEdits,
    principleIds: new Set(rulesOf(learned).map(({ id }) => id)),
    committed: new Set([PRINCIPLES_PATH, ...(rewrite._tag === 'Applied' ? rewrite.files : [])]),
  });

  if (
    principles._tag === 'Learned' &&
    principles.changes.length === 0 &&
    writtenRuleContents.size === 0 &&
    rewrite._tag !== 'Applied'
  ) {
    // The reply still names skipped edits, and a dropped rewrite's cause and sandbox fix.
    return { _tag: 'NothingToPropose', skipped, writtenRules, rewrite } satisfies LearnOutcome;
  }

  // Rendered again from what was learned, so the doc is the learn step's whatever the rewrite touched.
  const docText = renderPrinciplesDoc(learned);
  const docFiles: GitLabCommitFile[] = Option.match(committed, {
    onNone: () => [{ path: PRINCIPLES_PATH, content: docText, action: 'create' }],
    onSome: ({ text }) =>
      text === docText ? [] : [{ path: PRINCIPLES_PATH, content: docText, action: 'update' }],
  });
  const rewriteFiles = yield* Effect.forEach(
    rewrite._tag === 'Applied' ? rewrite.files : [],
    file =>
      fs.readFileString(file).pipe(
        Effect.orDie,
        Effect.map((content): GitLabCommitFile => ({ path: file, content, action: 'update' })),
      ),
  );

  const delivery = yield* deliver({
    projectId,
    route,
    config,
    principles,
    skipped,
    rewrite,
    writtenRules,
    files: [
      ...docFiles,
      ...[...writtenRuleContents].map(
        ([path, content]): GitLabCommitFile => ({ path, content, action: 'update' }),
      ),
      ...rewriteFiles,
    ],
  });
  return {
    _tag: 'Proposed',
    principles,
    skipped,
    writtenRules,
    rewrite,
    delivery,
  } satisfies LearnOutcome;
});

const failed = (reason: string): LearnOutcome => ({ _tag: 'Failed', reason, writtenRules: [] });

const removeRunFiles = Effect.flatMap(FileSystem.FileSystem, fs =>
  Effect.forEach(
    [TASK_FILE, ...Object.values(LEARN_RUN_FILES), ...Object.values(REWRITE_RUN_FILES)],
    file => fs.remove(file).pipe(Effect.ignore),
    { discard: true },
  ),
);

/** Where the learn run's commit landed, for the session log. */
const describeDelivery = (delivery: Delivery): string => {
  switch (delivery._tag) {
    case 'Pushed':
      return `Committed to the merge request's branch: ${delivery.commitUrl}`;
    case 'MergeRequest':
      return `Opened !${delivery.iid} with the commit`;
    case 'MergeRequestInsteadOfPush':
      return `GitLab refused the push, so opened !${delivery.iid} with the commit instead`;
  }
};

/** What came of the rewrite, for the session log. */
const describeRewrite = (rewrite: RewriteOutcome): string => {
  switch (rewrite._tag) {
    case 'Applied': {
      const changed = rewrite.files.length === 1 ? '1 file' : `${rewrite.files.length} files`;
      return `The rewrite changed ${changed}: ${oneLine(rewrite.summary)}`;
    }
    case 'Unchanged':
      return 'The code already follows the principles: the rewrite changed nothing';
    case 'Dropped':
      return `The rewrite was dropped: ${oneLine(rewrite.reason)}`;
  }
};

/** How the learn run ended, for the session log: the reply in the Done thread says it at length. */
const describeLearnOutcome = (outcome: LearnOutcome): readonly string[] => {
  switch (outcome._tag) {
    case 'Failed':
      return [`Learning stopped: ${oneLine(outcome.reason)}`];
    case 'NothingToPropose':
      return [describeRewrite(outcome.rewrite), 'Nothing to commit'];
    case 'Proposed':
      return [describeRewrite(outcome.rewrite), describeDelivery(outcome.delivery)];
  }
};

/** Ends every learn run: delivers what it learned, or says why it couldn't, in the Done thread. */
export const runPropose = Effect.fn('propose.run')(function* () {
  const projectId = yield* Config.NonEmptyString('DUO_WORKFLOW_PROJECT_ID');
  // Where to reply comes first: a run that goes wrong after this still says so there.
  const route = yield* readRoute();
  if (route._tag !== 'learn') return yield* userError({ message: 'expected a learn mention' });
  const mergeRequests = yield* GitLabMergeRequests;

  const read = yield* readProjectConfig();
  const tone = read._tag === 'Ok' ? read.config.tone : 'plain';
  const outcome: LearnOutcome = yield* Effect.gen(function* () {
    if (read._tag === 'Missing') return failed('this project has no .codetinder/config.json');
    if (read._tag === 'Invalid') {
      return failed(`.codetinder/config.json is invalid: ${oneLine(read.message)}`);
    }
    const roundId = yield* Schema.decodeEffect(RoundIdSchema)(route.roundId).pipe(
      Effect.mapError(error => userError(error, `"${route.roundId}" is not a round id`)),
    );
    return yield* learnOutcome({
      projectId,
      route: { mergeRequestIid: route.mergeRequestIid, roundId },
      config: read.config,
    });
  }).pipe(
    Effect.catchTags({
      UserError: error => Effect.succeed(failed(error.message)),
      GitFailed: error => Effect.succeed(failed(error.message)),
      GitLabRequestFailed: (error: GitLabRequestFailed) =>
        Effect.succeed(failed(`GitLab refused the proposal: ${error.message}`)),
    }),
    Effect.catchDefect(defect =>
      Effect.succeed(failed(`CodeTinder hit an unexpected error: ${oneLine(messageOf(defect))}`)),
    ),
  );

  const body = learnNote({ tone, outcome });
  const posted = yield* mergeRequests
    .replyToNote({
      projectId,
      mergeRequestIid: route.mergeRequestIid,
      noteId: route.noteId,
      body,
    })
    .pipe(
      // The Done reply was deleted since it started the run: answer on the MR instead.
      Effect.catchTag('NoteNotFound', () =>
        mergeRequests.createNote({ projectId, mergeRequestIid: route.mergeRequestIid, body }),
      ),
      Effect.mapError(error => error.message),
      Effect.catchDefect(defect => Effect.fail(messageOf(defect))),
      Effect.result,
    );
  yield* reportLearn({
    roundId: route.roundId,
    noteId: route.noteId,
    report: outcome._tag === 'Failed' ? 'Failed' : 'Finished',
  });
  yield* Effect.forEach(describeLearnOutcome(outcome), logSession, { discard: true });
  if (Result.isFailure(posted)) {
    yield* logSession(`Couldn't reply in the Done thread: ${oneLine(posted.failure)}`);
    yield* Console.log(`failed: couldn't post the note: ${oneLine(posted.failure)}`);
    return;
  }
  yield* logSession('Replied in the Done thread');

  if (outcome._tag === 'Failed') {
    yield* Console.log(`failed: ${oneLine(outcome.reason)}`);
    return;
  }
  yield* Console.log(outcome._tag === 'Proposed' ? 'proposed' : 'nothing to propose');
}, Effect.ensuring(removeRunFiles));

export const proposeCommand = Command.make('propose', {}, () =>
  runPropose().pipe(
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
    "Deliver a learn run's principles and rewrite as the project's config says, and post its note",
  ),
);
