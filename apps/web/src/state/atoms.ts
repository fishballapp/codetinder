import {
  Api,
  type AskId,
  type AskSuccess,
  Authentication,
  Forbidden,
  type RoundId,
  RoundIdSchema,
  RoundNotFound,
  Unauthorized,
} from '@codetinder/api';
import {
  AGENT_CONFIG_PATH,
  AGENT_INSTRUCTION_FILES,
  guessToolchain,
  learnReply,
  PRINCIPLES_PATH,
  PROJECT_CONFIG_PATH,
  type RepoFile,
  removalMergeRequestDescription,
  setupMergeRequestDescription,
  setupPlan,
  type Verdicts,
} from '@codetinder/core';
import {
  GitLabCatalog,
  GitLabCatalogError,
  GitLabDiscussions,
  GitLabFiles,
  GitLabMergeRequestLinks,
  type GitLabProject,
  GitLabProjects,
  GitLabRemoval,
  GitLabSetup,
  GitLabSweepPage,
  InvalidToken,
  isRoundTriggerCurrent,
  PipelineRefused,
  type RoundStart,
  roundStartsOf,
  roundTrigger,
  SWEEP_TRIGGER_DESCRIPTION,
  sweepTrigger,
} from '@codetinder/gitlab';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpApiClient from 'effect/http-api/HttpApiClient';
import * as HttpApiMiddleware from 'effect/http-api/HttpApiMiddleware';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import * as Reactivity from 'effect/reactivity/Reactivity';
import * as Schema from 'effect/Schema';
import { completeSignIn, Session, SignedOut, SignInFailed, startSignIn } from '../auth/auth';
import { type Addability, addability } from './addability';
import { type LearnedPrinciples, learnedPrinciples } from './learnedPrinciples';
import { LEARN_POLL_INTERVAL, shouldPollLearn } from './learnPoll';
import { type ProjectState, projectState } from './projectState';
import { findRoundThread } from './roundThread';
import { webRuntime } from './runtime';
import {
  isSweepStarting,
  lastEndedAtMs,
  linesSince,
  type ProjectSweep,
  SWEEP_POLL_INTERVAL,
  type SweepStart,
} from './sweepStatus';
import { toastManager, type WriteToastCopy, withWriteToast } from './toasts';
import { makeWriteQueue } from './writeQueue';

export { RoundNotFound, SignedOut, SignInFailed };

/** The project's round trigger is gone, so a new trigger has no service account to run as. */
export class FlowTriggerMissing extends Schema.TaggedError<FlowTriggerMissing>()(
  'FlowTriggerMissing',
  { message: Schema.String },
) {}

/** The round's MR has no thread from CodeTinder linking the round, so Done has nowhere to reply. */
export class RoundThreadNotFound extends Schema.TaggedError<RoundThreadNotFound>()(
  'RoundThreadNotFound',
  { message: Schema.String },
) {}

/** The signed-in developer's GitLab token, or `SignedOut`. */
const developerToken = Effect.gen(function* () {
  const session = yield* Session;
  const token = yield* session.getValidAccessToken();
  if (token === null) {
    return yield* new SignedOut({ message: 'Not signed in to GitLab' });
  }
  return token;
});

export const makeAuthenticatedApiClient = (token: string) => {
  const authMiddleware = HttpApiMiddleware.layerClient(Authentication, ({ request, next }) =>
    next(request.pipe(HttpClientRequest.bearerToken(Redacted.make(token)))),
  );
  return HttpApiClient.make(Api).pipe(Effect.provide(authMiddleware));
};

type ApiClient = Effect.Success<ReturnType<typeof makeAuthenticatedApiClient>>;

/** Sends the browser to GitLab; once signed in, it comes back to `returnTo`. */
export const startSignInAtom = webRuntime.fn((returnTo: string) => startSignIn(returnTo));

// Kept alive for the page's life: a remount (StrictMode, navigation) must reuse the one exchange,
// because GitLab accepts an authorization code once.
export const authCallbackAtom = Atom.family((key: string) =>
  webRuntime
    .atom(_get =>
      Effect.gen(function* () {
        const separatorIndex = key.indexOf(':');
        if (separatorIndex === -1) {
          return yield* new SignInFailed({ message: 'Invalid callback parameters' });
        }
        const code = key.slice(0, separatorIndex);
        const state = key.slice(separatorIndex + 1);
        return yield* completeSignIn({ code, state });
      }),
    )
    .pipe(Atom.keepAlive),
);

/** Reactivity key of the developer's projects: a write that changes one names it. */
const PROJECTS = 'projects';

export type ProjectWithState = GitLabProject & {
  readonly state: ProjectState;
  /** Whether CodeTinder can be added to it, and if not, why. */
  readonly addability: Addability;
  /** The `codetinder` flow's consumer while the flow is on: its trigger holds how rounds start. */
  readonly consumerId: string | null;
  /** Whether the developer may manage the flow there, its trigger included. */
  readonly canManageFlow: boolean;
};

/** The projects the developer can push to, most recently active first, with CodeTinder's state. */
export const projectsAtom = webRuntime
  .atom(_get =>
    Effect.gen(function* () {
      const token = Redacted.make(yield* developerToken);
      const projects = yield* (yield* GitLabProjects).listWritable(token);
      const { latestVersion, projects: setups } = yield* (yield* GitLabCatalog).setupStatuses({
        token,
        projectFullPaths: projects.map(project => project.fullPath),
        configPath: PROJECT_CONFIG_PATH,
      });
      const setupByPath = new Map(setups.map(setup => [setup.fullPath, setup]));
      return projects.flatMap((project): ProjectWithState[] => {
        const setup = setupByPath.get(project.fullPath);
        if (setup === undefined) return [];
        return [
          {
            ...project,
            state: projectState(setup, latestVersion),
            addability: addability({
              isMarkedForDeletion: setup.isMarkedForDeletion,
              canEnableFlow: setup.canEnableFlow,
              hasFlow: setup.consumer !== null,
              defaultBranch: project.defaultBranch,
            }),
            consumerId: setup.consumer?.id ?? null,
            canManageFlow: setup.canEnableFlow,
          },
        ];
      });
    }),
  )
  .pipe(webRuntime.factory.withReactivity([PROJECTS]));

/**
 * What the setup MR would do to a project, with its toolchain guessed from its root, all read at
 * one commit of its default branch: `baseSha`, which the MR's branch starts from.
 */
export const setupPlanAtom = Atom.family((projectId: number) =>
  webRuntime.atom(get =>
    Effect.gen(function* () {
      const project = (yield* get.result(projectsAtom)).find(({ id }) => id === projectId);
      if (project === undefined || project.defaultBranch === null) {
        return yield* Effect.die(new Error(`Project ${projectId} has no default branch to set up`));
      }
      const setup = yield* GitLabSetup;
      const token = Redacted.make(yield* developerToken);
      const projectIdText = String(projectId);
      const baseSha = yield* setup.branchHead({
        token,
        projectId: projectIdText,
        branch: project.defaultBranch,
      });
      const files = yield* GitLabFiles;
      const readRepoFile = (path: string) =>
        files.readText({ token, projectId: projectIdText, path, ref: baseSha }).pipe(
          Effect.map(
            (text): RepoFile =>
              Option.match(text, {
                onNone: () => ({ _tag: 'Missing' }),
                onSome: content => ({ _tag: 'Text', content }),
              }),
          ),
          Effect.catchTag('FileNotUtf8', () => Effect.succeed<RepoFile>({ _tag: 'NotUtf8' })),
        );
      const [fileNames, agentConfig, instructionFiles] = yield* Effect.all(
        [
          setup.rootFileNames({ token, projectId: projectIdText, ref: baseSha }),
          readRepoFile(AGENT_CONFIG_PATH),
          Effect.forEach(AGENT_INSTRUCTION_FILES, path => readRepoFile(path), {
            concurrency: 'unbounded',
          }),
        ],
        { concurrency: 'unbounded' },
      );
      const agentInstructions = AGENT_INSTRUCTION_FILES.flatMap((path, index) => {
        const file = instructionFiles[index];
        return file === undefined || file._tag === 'Missing' ? [] : [{ path, file }];
      });
      return {
        ...setupPlan({ toolchain: guessToolchain(fileNames), agentConfig, agentInstructions }),
        baseSha,
      };
    }),
  ),
);

/**
 * Add to project, or the rest of a half-done add: turns the flow on and opens the setup MR with
 * the files `setupPlanAtom` shows, each only if needed. Answers the setup MR's URL: the one it
 * opened, or the one already waiting.
 *
 * The projects refresh even when it fails partway, so a retry sees the flow it already turned on.
 * A setup branch left behind with no open MR (a closed setup MR, or one that failed to open) is
 * CodeTinder's own, so it is replaced.
 */
export const addProjectAtom = webRuntime.fn(
  (
    {
      projectId,
      defaultBranch,
      needsFlow,
      needsSetupMergeRequest,
      setupMergeRequestUrl,
    }: {
      readonly projectId: number;
      readonly defaultBranch: string;
      readonly needsFlow: boolean;
      readonly needsSetupMergeRequest: boolean;
      /** The setup MR already open, when there is one. */
      readonly setupMergeRequestUrl: string | null;
    },
    get,
  ) =>
    Effect.gen(function* () {
      const token = Redacted.make(yield* developerToken);
      if (needsFlow) {
        yield* (yield* GitLabCatalog).enable({ token, projectId: String(projectId) });
      }
      if (!needsSetupMergeRequest) {
        return { projectId, setupMergeRequestUrl };
      }
      const plan = yield* get.result(setupPlanAtom(projectId));
      const openedUrl = yield* (yield* GitLabSetup).openSetupMergeRequest({
        token,
        projectId: String(projectId),
        defaultBranch,
        baseSha: plan.baseSha,
        files: plan.files,
        description: setupMergeRequestDescription(plan),
      });
      return { projectId, setupMergeRequestUrl: openedUrl };
    }).pipe(Effect.ensuring(Reactivity.invalidate([PROJECTS]))),
);

/**
 * Brings a project's trigger up to how rounds start now, keeping the ways it starts them: a
 * trigger from before the setting (MR created and mention) gains the ready event.
 */
export const bringRoundTriggerUp = Effect.fn('bringRoundTriggerUp')(function* ({
  token,
  consumerId,
  projectFullPath,
  defaultBranch,
}: {
  readonly token: Redacted.Redacted<string>;
  readonly consumerId: string;
  readonly projectFullPath: string;
  readonly defaultBranch: string | null;
}) {
  const catalog = yield* GitLabCatalog;
  const { round } = yield* catalog.flowTriggers({ token, projectFullPath, consumerId });
  if (Option.isNone(round) || isRoundTriggerCurrent(round.value.eventTypes)) return;
  yield* catalog.updateTrigger({
    token,
    triggerId: round.value.id,
    ...roundTrigger({ starts: roundStartsOf(round.value.eventTypes), defaultBranch }),
  });
});

/** Update: moves a project's flow to the catalog's latest version, and brings its trigger up. */
export const updateProjectAtom = webRuntime.fn(
  ({
    projectId,
    consumerId,
    version,
    projectFullPath,
    defaultBranch,
  }: {
    readonly projectId: number;
    readonly consumerId: string;
    readonly version: string;
    readonly projectFullPath: string;
    readonly defaultBranch: string | null;
  }) =>
    Effect.gen(function* () {
      const token = Redacted.make(yield* developerToken);
      yield* (yield* GitLabCatalog).update({ token, consumerId, version });
      yield* bringRoundTriggerUp({ token, consumerId, projectFullPath, defaultBranch });
    }).pipe(Effect.ensuring(Reactivity.invalidate([PROJECTS, flowTriggersKey(projectId)]))),
);

/** Reactivity key of a project's flow triggers. */
const flowTriggersKey = (projectId: number) => `flow-triggers:${projectId}`;

/** A project's flow triggers, round and sweep, and whether it has the CI a pipeline event needs. */
export const flowTriggersAtom = Atom.family((projectId: number) =>
  webRuntime
    .atom(get =>
      Effect.gen(function* () {
        const project = (yield* get.result(projectsAtom)).find(({ id }) => id === projectId);
        if (project === undefined || project.consumerId === null) {
          return yield* Effect.die(new Error(`Project ${projectId} has no CodeTinder flow`));
        }
        const token = Redacted.make(yield* developerToken);
        return yield* (yield* GitLabCatalog).flowTriggers({
          token,
          projectFullPath: project.fullPath,
          consumerId: project.consumerId,
        });
      }),
    )
    .pipe(webRuntime.factory.withReactivity([flowTriggersKey(projectId)])),
);

/**
 * How a project's rounds start, read off its flow's trigger, whether the trigger has every event
 * those ways need now, whether the project has the CI a push needs, and the account a mention
 * reaches. None when the trigger is gone.
 */
export const roundTriggerAtom = Atom.family((projectId: number) =>
  webRuntime.atom(get =>
    Effect.gen(function* () {
      const { round, hasCiConfig, serviceAccountUsername } = yield* get.result(
        flowTriggersAtom(projectId),
      );
      return {
        trigger: Option.map(round, ({ id, eventTypes }) => ({
          id,
          starts: roundStartsOf(eventTypes),
          isCurrent: isRoundTriggerCurrent(eventTypes),
        })),
        hasCiConfig,
        serviceAccountUsername,
      };
    }),
  ),
);

/** A write's refusal in the words of whoever refused it, when it says something to act on. */
const refusalText = (error: unknown): string | undefined => {
  if (
    error instanceof SignedOut ||
    error instanceof InvalidToken ||
    error instanceof Unauthorized
  ) {
    return 'GitLab signed you out. Sign in again, then try once more.';
  }
  if (error instanceof FlowTriggerMissing) {
    return 'This project’s CodeTinder trigger was deleted in GitLab. Remove CodeTinder and add it again.';
  }
  if (error instanceof Forbidden) {
    return 'Only someone who can push to this project can change this.';
  }
  if (error instanceof GitLabCatalogError || error instanceof PipelineRefused) {
    return `GitLab said: ${error.message}`;
  }
  return undefined;
};

/**
 * A page section's writes, one at a time: each rewrites a trigger or a setting whole, so the next
 * waits for it and reads what it wrote.
 */
const writeQueueAtom = Atom.family((_section: string) =>
  Atom.make(() => makeWriteQueue()).pipe(Atom.keepAlive),
);

/**
 * Refreshes the reads under `keys` and waits for `read` to load again, so a field shows what its
 * write saved the moment the write ends. A read that fails to load shows its own failure; it
 * never fails the write, which went through.
 */
const refreshAfterWrite = <E>({
  get,
  keys,
  read,
}: {
  readonly get: Atom.FnContext;
  readonly keys: ReadonlyArray<string>;
  readonly read: Atom.Atom<AsyncResult.AsyncResult<unknown, E>>;
}) =>
  Reactivity.invalidate(keys).pipe(
    Effect.andThen(get.result(read, { suspendOnWaiting: true })),
    Effect.ignoreCause,
  );

/**
 * Ticks or unticks one way a project's rounds start. The trigger is read afresh and written whole
 * (its events and filter) after any write queued before, so quick clicks each land.
 */
export const setRoundStartAtom = webRuntime.fn(
  (
    {
      projectId,
      start,
      isOn,
      ...target
    }: {
      readonly projectId: number;
      readonly projectFullPath: string;
      readonly consumerId: string;
      readonly defaultBranch: string | null;
      readonly start: RoundStart;
      readonly isOn: boolean;
    },
    get,
  ) =>
    withWriteToast(
      get(writeQueueAtom(`round-starts:${projectId}`))(
        writeRoundStart({ ...target, start, isOn }).pipe(
          Effect.ensuring(
            refreshAfterWrite({
              get,
              keys: [flowTriggersKey(projectId)],
              read: flowTriggersAtom(projectId),
            }),
          ),
        ),
      ),
      {
        loading: 'Saving round starts…',
        success: 'Round starts saved',
        failureTitle: 'Couldn’t save round starts',
        refusal: refusalText,
        noAnswer: 'GitLab didn’t answer this time. Try again to be sure.',
      },
    ),
  { concurrent: true },
);

const writeRoundStart = Effect.fn('writeRoundStart')(function* ({
  projectFullPath,
  consumerId,
  defaultBranch,
  start,
  isOn,
}: {
  readonly projectFullPath: string;
  readonly consumerId: string;
  readonly defaultBranch: string | null;
  readonly start: RoundStart;
  readonly isOn: boolean;
}) {
  const token = Redacted.make(yield* developerToken);
  const catalog = yield* GitLabCatalog;
  const { round } = yield* catalog.flowTriggers({ token, projectFullPath, consumerId });
  if (Option.isNone(round)) {
    return yield* new FlowTriggerMissing({
      message: 'This project’s CodeTinder trigger was deleted in GitLab',
    });
  }
  const starts = roundStartsOf(round.value.eventTypes);
  yield* catalog.updateTrigger({
    token,
    triggerId: round.value.id,
    ...roundTrigger({
      starts: isOn ? starts.union(new Set([start])) : starts.difference(new Set([start])),
      defaultBranch,
    }),
  });
});

/** Reactivity key of a project's sweep. */
const sweepKey = (projectId: number) => `sweep:${projectId}`;

/** The Sweep now pressed on a project in this tab, if any. */
const sweepStartAtom = Atom.family((projectId: number) =>
  Atom.make<SweepStart | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`sweep-start:${projectId}`),
  ),
);

/**
 * A project's sweep: its threshold, its last sweep with that sweep's MR, a stop since, the lines of code
 * changed on the default branch since (none before the first sweep), what carried over, whether
 * a run is sweeping now and whether a Sweep now is on its way. While either, it reads itself again
 * every `SWEEP_POLL_INTERVAL`, so the page follows the sweep to its result.
 */
export const sweepAtom = Atom.family((projectId: number) =>
  webRuntime
    .atom(get =>
      Effect.gen(function* () {
        const start = get(sweepStartAtom(projectId));
        const project = (yield* get.result(projectsAtom)).find(({ id }) => id === projectId);
        if (project === undefined || project.defaultBranch === null) {
          return yield* Effect.die(
            new Error(`Project ${projectId} has no default branch to sweep`),
          );
        }
        const token = yield* developerToken;
        const client = yield* makeAuthenticatedApiClient(token);
        const projectIdText = String(projectId);
        const sweep = yield* client.sweeps.get({ params: { projectId: projectIdText } });
        const gitLab = yield* GitLabSweepPage;
        const { last } = sweep;
        const [changed, outcome] = yield* Effect.all(
          [
            last === null
              ? Effect.succeed(null)
              : gitLab
                  .compare({
                    token: Redacted.make(token),
                    projectId: projectIdText,
                    from: last.sha,
                    to: project.defaultBranch,
                  })
                  .pipe(Effect.map(linesSince)),
            last?.outcome._tag === 'Proposed'
              ? gitLab
                  .mergeRequest({
                    token: Redacted.make(token),
                    projectId: projectIdText,
                    mergeRequestIid: last.outcome.mergeRequestIid,
                  })
                  .pipe(Effect.map(mergeRequest => ({ ...last.outcome, mergeRequest })))
              : Effect.succeed({ _tag: 'Clean' } as const),
          ],
          { concurrency: 'unbounded' },
        );
        const isStarting = isSweepStarting({
          start,
          isRunning: sweep.isRunning,
          lastEndedAtMs: lastEndedAtMs(sweep),
          nowMs: yield* Clock.currentTimeMillis,
        });
        if (sweep.isRunning || isStarting) {
          yield* Effect.forkScoped(
            Effect.sleep(SWEEP_POLL_INTERVAL).pipe(
              Effect.andThen(Effect.sync(() => get.refreshSelf())),
            ),
          );
        }
        return {
          threshold: sweep.threshold,
          last: last === null ? null : { at: last.at, outcome },
          stopped: sweep.stopped,
          linesSince: changed,
          carryOver: sweep.carryOver.length,
          isRunning: sweep.isRunning,
          isStarting,
        } satisfies ProjectSweep;
      }),
    )
    .pipe(webRuntime.factory.withReactivity([sweepKey(projectId)])),
);

/**
 * The page of the session sweeping a project, once GitLab has started it: looked up each time the
 * sweep is read while one runs or is on its way, none otherwise.
 */
export const sweepSessionAtom = Atom.family((projectId: number) =>
  webRuntime.atom(get =>
    Effect.gen(function* () {
      const { isRunning, isStarting } = yield* get.result(sweepAtom(projectId));
      if (!isRunning && !isStarting) return Option.none<string>();
      const project = (yield* get.result(projectsAtom)).find(({ id }) => id === projectId);
      if (project === undefined || project.defaultBranch === null) {
        const noDefaultBranch = `Project ${projectId} has no default branch to sweep`;
        return yield* Effect.die(new Error(noDefaultBranch));
      }
      return yield* (yield* GitLabSweepPage).sweepSession({
        token: Redacted.make(yield* developerToken),
        projectFullPath: project.fullPath,
        defaultBranch: project.defaultBranch,
      });
    }),
  ),
);

/** Where a project's flow is, which a sweep trigger is written to. */
type FlowTarget = {
  readonly token: Redacted.Redacted<string>;
  readonly projectFullPath: string;
  readonly consumerId: string;
  readonly defaultBranch: string;
};

/** Creates the sweep trigger, running as the flow's service account, the round trigger's. */
const createSweepTrigger = Effect.fn('createSweepTrigger')(function* ({
  target: { token, projectFullPath, consumerId, defaultBranch },
  serviceAccountId,
  isAutomatic,
}: {
  readonly target: FlowTarget;
  readonly serviceAccountId: Option.Option<string>;
  readonly isAutomatic: boolean;
}) {
  if (Option.isNone(serviceAccountId)) {
    return yield* new FlowTriggerMissing({
      message: 'This project’s CodeTinder trigger was deleted in GitLab',
    });
  }
  yield* (yield* GitLabCatalog).createTrigger({
    token,
    projectFullPath,
    consumerId,
    serviceAccountId: serviceAccountId.value,
    description: SWEEP_TRIGGER_DESCRIPTION,
    ...sweepTrigger({ isAutomatic, defaultBranch }),
  });
});

/**
 * Turns automatic sweeping on or off: the sweep trigger written whole, created if absent. Two
 * writes racing to create it leave two; this keeps the first and deletes the rest, so none is
 * left sweeping on every merge.
 */
export const writeSweepTrigger = Effect.fn('writeSweepTrigger')(function* ({
  isAutomatic,
  ...target
}: FlowTarget & { readonly isAutomatic: boolean }) {
  const catalog = yield* GitLabCatalog;
  const {
    sweeps: [sweep, ...duplicates],
    serviceAccountId,
  } = yield* catalog.flowTriggers(target);
  if (sweep === undefined) {
    return yield* createSweepTrigger({ target, serviceAccountId, isAutomatic });
  }
  yield* catalog.updateTrigger({
    token: target.token,
    triggerId: sweep.id,
    ...sweepTrigger({ isAutomatic, defaultBranch: target.defaultBranch }),
  });
  yield* Effect.forEach(
    duplicates,
    ({ id }) => catalog.deleteTrigger({ token: target.token, triggerId: id }),
    { concurrency: 'unbounded', discard: true },
  );
});

/**
 * Sweep now: makes sure the sweep trigger exists (off, hearing only the API, when it doesn't), then
 * starts a pipeline on the default branch as the developer, which it hears.
 */
export const startSweep = Effect.fn('startSweep')(function* ({
  projectId,
  ...target
}: FlowTarget & { readonly projectId: number }) {
  const { sweeps, serviceAccountId } = yield* (yield* GitLabCatalog).flowTriggers(target);
  if (sweeps.length === 0) {
    yield* createSweepTrigger({ target, serviceAccountId, isAutomatic: false });
  }
  yield* (yield* GitLabSweepPage).startPipeline({
    token: target.token,
    projectId: String(projectId),
    ref: target.defaultBranch,
  });
});

/** One of the sweep's settings: automatic sweeping, on the trigger, or lines per sweep, on codetinder.dev. */
export type SweepSetting =
  | { readonly _tag: 'Automatic'; readonly isAutomatic: boolean }
  | { readonly _tag: 'Threshold'; readonly threshold: number };

const writeSweepSetting = Effect.fn('writeSweepSetting')(function* ({
  projectId,
  setting,
  ...target
}: Omit<FlowTarget, 'token'> & { readonly projectId: number; readonly setting: SweepSetting }) {
  const token = yield* developerToken;
  if (setting._tag === 'Automatic') {
    return yield* writeSweepTrigger({
      token: Redacted.make(token),
      ...target,
      isAutomatic: setting.isAutomatic,
    });
  }
  const client = yield* makeAuthenticatedApiClient(token);
  yield* client.sweeps.putThreshold({
    params: { projectId: String(projectId) },
    payload: { threshold: setting.threshold },
  });
});

const sweepSettingToastCopy = (setting: SweepSetting): WriteToastCopy => {
  if (setting._tag === 'Threshold') {
    return {
      loading: 'Saving lines per sweep…',
      success: 'Lines per sweep saved',
      failureTitle: 'Couldn’t save lines per sweep',
      refusal: refusalText,
      noAnswer: 'codetinder.dev didn’t answer this time. Try again to be sure.',
    };
  }
  const onOrOff = setting.isAutomatic ? 'on' : 'off';
  return {
    loading: `Turning automatic sweeping ${onOrOff}…`,
    success: `Automatic sweeping ${onOrOff}`,
    failureTitle: `Couldn’t turn automatic sweeping ${onOrOff}`,
    refusal: refusalText,
    noAnswer: 'GitLab didn’t answer this time. Try again to be sure.',
  };
};

/** Saves one of the sweep's settings, after any queued before it on the same project. */
export const saveSweepSettingAtom = webRuntime.fn(
  (
    {
      projectId,
      setting,
      ...target
    }: Omit<FlowTarget, 'token'> & { readonly projectId: number; readonly setting: SweepSetting },
    get,
  ) =>
    withWriteToast(
      get(writeQueueAtom(`sweep:${projectId}`))(
        writeSweepSetting({ projectId, setting, ...target }).pipe(
          Effect.ensuring(
            refreshAfterWrite({
              get,
              keys: [flowTriggersKey(projectId), sweepKey(projectId)],
              read:
                setting._tag === 'Automatic' ? flowTriggersAtom(projectId) : sweepAtom(projectId),
            }),
          ),
        ),
      ),
      sweepSettingToastCopy(setting),
    ),
  { concurrent: true },
);

/**
 * Sweep now, see `startSweep`. Once the pipeline starts the project's sweep reads as starting,
 * until a run claims it or a new sweep ends.
 */
export const sweepNowAtom = webRuntime.fn(
  (
    {
      lastEndedAtMs,
      ...target
    }: {
      readonly projectId: number;
      readonly projectFullPath: string;
      readonly consumerId: string;
      readonly defaultBranch: string;
      /** When the latest sweep before this one ended; none before the first. */
      readonly lastEndedAtMs: number | null;
    },
    get,
  ) =>
    withWriteToast(
      Effect.gen(function* () {
        const token = Redacted.make(yield* developerToken);
        yield* startSweep({ token, ...target });
        get.set(sweepStartAtom(target.projectId), {
          atMs: yield* Clock.currentTimeMillis,
          lastEndedAtMs,
        });
      }).pipe(Effect.ensuring(Reactivity.invalidate([flowTriggersKey(target.projectId)]))),
      {
        loading: 'Starting a sweep…',
        success: 'Sweep started',
        failureTitle: 'Couldn’t start the sweep',
        refusal: refusalText,
        noAnswer: 'GitLab didn’t answer this time. Nothing started: try again.',
      },
    ),
);

/**
 * Remove's steps for one project: turns the flow off, closes the setup MR if one is open, and opens
 * the MR that deletes the config. Each runs only if it is still needed, judged from the project's
 * state read now, so a retry finishes what a failed removal left.
 */
export const removeProject = Effect.fn('removeProject')(function* ({
  token,
  projectId,
  fullPath,
}: {
  readonly token: Redacted.Redacted<string>;
  readonly projectId: number;
  readonly fullPath: string;
}) {
  const catalog = yield* GitLabCatalog;
  const { projects: setups } = yield* catalog.setupStatuses({
    token,
    projectFullPaths: [fullPath],
    configPath: PROJECT_CONFIG_PATH,
  });
  const setup = setups.find(project => project.fullPath === fullPath);
  if (setup === undefined) return;

  const projectIdText = String(projectId);
  const defaultBranch = yield* (yield* GitLabSetup).defaultBranch({
    token,
    projectId: projectIdText,
  });
  if (setup.consumer !== null) {
    yield* catalog.disable({ token, consumerId: setup.consumer.id });
  }
  const removal = yield* GitLabRemoval;
  if (setup.setupMergeRequestUrl !== null) {
    yield* removal.closeSetupMergeRequest({ token, projectId: projectIdText, defaultBranch });
  }
  // Every Remove, not only the one that closed the MR: a branch whose close succeeded but whose
  // delete failed must not outlive the retry, or the next add is blocked by it.
  yield* removal.deleteSetupBranch({ token, projectId: projectIdText });
  if (setup.hasConfig && setup.removalMergeRequest === null) {
    yield* removal.openRemovalMergeRequest({
      token,
      projectId: projectIdText,
      defaultBranch,
      configPath: PROJECT_CONFIG_PATH,
      description: removalMergeRequestDescription(),
    });
  }
});

/** Remove: takes a project off CodeTinder, see `removeProject`. Refreshes even when it fails partway. */
export const removeProjectAtom = webRuntime.fn(
  ({ projectId, fullPath }: { readonly projectId: number; readonly fullPath: string }) =>
    Effect.gen(function* () {
      const token = Redacted.make(yield* developerToken);
      yield* removeProject({ token, projectId, fullPath });
    }).pipe(Effect.ensuring(Reactivity.invalidate([PROJECTS]))),
);

/** What CodeTinder has learned in a project: its principles doc at `ref`. */
export const readLearnedPrinciples = Effect.fn('readLearnedPrinciples')(function* ({
  token,
  projectId,
  ref,
}: {
  readonly token: Redacted.Redacted<string>;
  readonly projectId: number;
  readonly ref: string;
}) {
  const files = yield* GitLabFiles;
  return yield* files
    .readText({ token, projectId: String(projectId), path: PRINCIPLES_PATH, ref })
    .pipe(
      Effect.map(doc => learnedPrinciples(Option.getOrUndefined(doc))),
      // Not text CodeTinder wrote: the page can't list it, as with any doc out of shape.
      Effect.catchTag('FileNotUtf8', () =>
        Effect.succeed<LearnedPrinciples>({ _tag: 'Unreadable', reason: 'other-format' }),
      ),
    );
});

/** A project's principles doc on its default branch, see `readLearnedPrinciples`. */
export const learnedPrinciplesAtom = Atom.family((projectId: number) =>
  webRuntime.atom(get =>
    Effect.gen(function* () {
      const project = (yield* get.result(projectsAtom)).find(({ id }) => id === projectId);
      if (project === undefined) {
        return yield* Effect.die(new Error(`Project ${projectId} isn't one of the developer's`));
      }
      // An empty repository has no branch, so no doc.
      if (project.defaultBranch === null) {
        return learnedPrinciples(undefined);
      }
      const token = Redacted.make(yield* developerToken);
      return yield* readLearnedPrinciples({ token, projectId, ref: project.defaultBranch });
    }),
  ),
);

/** A round, with the verdicts the signed-in developer has already given it. */
export const roundDetailsAtom = Atom.family((rawId: string) =>
  webRuntime.atom(_get =>
    Effect.gen(function* () {
      const roundIdOption = Schema.decodeOption(RoundIdSchema)(rawId);
      if (Option.isNone(roundIdOption)) {
        return yield* new RoundNotFound({ message: 'Round not found' });
      }
      const roundId = roundIdOption.value;
      const token = yield* developerToken;

      const client = yield* makeAuthenticatedApiClient(token);
      const [round, myVerdicts] = yield* Effect.all(
        [
          client.rounds.getById({ params: { id: roundId } }),
          client.rounds.getMySwipes({ params: { id: roundId } }),
        ],
        { concurrency: 'unbounded' },
      );

      return { round, myVerdicts };
    }),
  ),
);

/**
 * Where the round's MR is, its Changes tab scrolled to the picked function, and each context
 * definition's lines at the MR's head.
 */
export const roundLinksAtom = Atom.family((rawId: string) =>
  webRuntime.atom(get =>
    Effect.gen(function* () {
      const { round } = yield* get.result(roundDetailsAtom(rawId));
      const token = yield* developerToken;
      const links = yield* GitLabMergeRequestLinks;
      return yield* links.forRound({
        token: Redacted.make(token),
        projectId: round.projectId,
        mergeRequestIid: round.mergeRequestIid,
        target: round.round.target,
        context: round.round.context,
      });
    }),
  ),
);

/** Reactivity key of where learning a round's swipes stands. */
const learnKey = (roundId: RoundId) => `learn:${roundId}`;

/**
 * Where learning the round's swipes, as they are now, stands. While it may still change, or after
 * a read that failed, it reads itself again every `LEARN_POLL_INTERVAL` (see `shouldPollLearn`),
 * so the page follows the learn run to its end.
 */
export const roundLearnAtom = Atom.family((roundId: RoundId) =>
  webRuntime
    .atom(get =>
      Effect.gen(function* () {
        const client = yield* makeAuthenticatedApiClient(yield* developerToken);
        const read = yield* client.rounds.getLearn({ params: { id: roundId } }).pipe(Effect.exit);
        if (shouldPollLearn(read)) {
          yield* Effect.forkScoped(
            Effect.sleep(LEARN_POLL_INTERVAL).pipe(
              Effect.andThen(Effect.sync(() => get.refreshSelf())),
            ),
          );
        }
        return yield* read;
      }),
    )
    .pipe(webRuntime.factory.withReactivity([learnKey(roundId)])),
);

/**
 * Saves the developer's verdicts on a round, all of them each time, replacing what was saved. A
 * new save interrupts one still running, so the last verdicts win; where learning stands is read
 * again after.
 *
 * ponytail: an interrupted save the server already received can still land after the next one,
 * dropping the latest verdict until the next swipe saves them all again. Rare and self-healing, so
 * saves are not queued.
 */
export const saveVerdictsAtom = Atom.family((roundId: RoundId) =>
  webRuntime.fn((verdicts: Verdicts) =>
    Effect.gen(function* () {
      const client = yield* makeAuthenticatedApiClient(yield* developerToken);
      yield* client.rounds.putSwipes({ params: { id: roundId }, payload: { verdicts } });
    }).pipe(Effect.ensuring(Reactivity.invalidate([learnKey(roundId)]))),
  ),
);

/** The round's MR, which its learn mention is posted on. */
type RoundMergeRequest = { readonly projectId: string; readonly mergeRequestIid: number };

/**
 * Asks for the round's swipes to be learned, as the developer: finds the round's thread on the MR,
 * records the ask with `record` (the server refuses one already asked), replies in the thread with
 * the mention that starts the learn run, then ties the ask to that reply, whose run reports how
 * learning goes. Answers the reply's note id.
 */
const askInThread = Effect.fn('askInThread')(function* <E>({
  roundId,
  projectId,
  mergeRequestIid,
  record,
}: RoundMergeRequest & {
  readonly roundId: RoundId;
  readonly record: (client: ApiClient) => Effect.Effect<AskSuccess, E>;
}) {
  const token = yield* developerToken;
  const client = yield* makeAuthenticatedApiClient(token);
  const discussions = yield* GitLabDiscussions;
  const thread = findRoundThread(
    yield* discussions.list({ token: Redacted.make(token), projectId, mergeRequestIid }),
    roundId,
  );
  if (thread === undefined) {
    return yield* new RoundThreadNotFound({
      message: "CodeTinder's note for this round isn't on the merge request",
    });
  }
  const { askId } = yield* record(client);
  const { noteId } = yield* discussions.reply({
    token: Redacted.make(token),
    projectId,
    mergeRequestIid,
    discussionId: thread.discussionId,
    body: learnReply({ serviceAccount: thread.serviceAccount, roundId }),
  });
  // ponytail: a tie lost after the reply posted (the tab closed, codetinder.dev unreachable past
  // the retries) leaves the run's reports unheard, so the round reads Didn't finish once its
  // deadline passes though the run learned. Rare, and Learn again recovers it.
  yield* client.rounds
    .putAskNote({ params: { id: roundId }, payload: { askId, noteId } })
    .pipe(Effect.retry({ times: 2 }));
  return noteId;
});

/**
 * Done: saves the verdicts, then asks for them to be learned in the round's thread (see
 * `askInThread`). Answers the reply's URL.
 */
export const doneAtom = Atom.family((roundId: RoundId) =>
  webRuntime.fn(
    ({
      verdicts,
      projectId,
      mergeRequestIid,
      mergeRequestUrl,
    }: RoundMergeRequest & {
      readonly verdicts: Verdicts;
      readonly mergeRequestUrl: string;
    }) =>
      Effect.gen(function* () {
        const client = yield* makeAuthenticatedApiClient(yield* developerToken);
        yield* client.rounds.putSwipes({ params: { id: roundId }, payload: { verdicts } });
        const noteId = yield* askInThread({
          roundId,
          projectId,
          mergeRequestIid,
          record: api => api.rounds.recordDone({ params: { id: roundId } }),
        });
        return `${mergeRequestUrl}#note_${noteId}`;
      }).pipe(Effect.ensuring(Reactivity.invalidate([learnKey(roundId)]))),
  ),
);

/**
 * Asks again, by itself, for an ask GitLab never started: once, since the server refuses to ask
 * again for an ask that was itself asked again, and only one of two pages asking gets it. A
 * failure to ask is a toast; Done reads Learn again either way.
 */
export const retryLearnAtom = Atom.family((roundId: RoundId) =>
  webRuntime.fn(({ askId, ...mergeRequest }: RoundMergeRequest & { readonly askId: AskId }) =>
    askInThread({
      roundId,
      ...mergeRequest,
      record: api => api.rounds.retryLearn({ params: { id: roundId }, payload: { askId } }),
    }).pipe(
      Effect.asVoid,
      // Another page asked first, or GitLab started the run after all: nothing to tell.
      Effect.catchTag('RetryNotDue', () => Effect.void),
      // Any failure, a GitLab 503 or a lost connection (defects) included; not the page leaving.
      Effect.tapCause(cause =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() =>
              toastManager.add({
                title: "Couldn't ask GitLab again",
                description: 'Press Learn again to give it another go.',
                timeout: 0,
                priority: 'high',
              }),
            ),
      ),
      Effect.ensuring(Reactivity.invalidate([learnKey(roundId)])),
    ),
  ),
);
