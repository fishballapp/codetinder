import { Checkbox } from '@base-ui/react/checkbox';
import { Field } from '@base-ui/react/field';
import { NumberField } from '@base-ui/react/number-field';
import type { SweepStopCause } from '@codetinder/api';
import { canFlowSweep, SWEEP_FLOW_VERSION } from '@codetinder/gitlab';
import { cn } from '@codetinder/ui';
import { useAtom, useAtomValue } from '@effect/atom-react';
import { ArrowSquareOutIcon, BroomIcon, CheckIcon, HeartIcon } from '@phosphor-icons/react';
import * as DateTime from 'effect/DateTime';
import * as Option from 'effect/Option';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react';
import {
  flowTriggersAtom,
  type ProjectWithState,
  type SweepSetting,
  saveSweepSettingAtom,
  sweepAtom,
  sweepNowAtom,
  sweepSessionAtom,
} from '../state/atoms';
import {
  type LinesSince,
  lastEndedAtMs,
  type ProjectSweep,
  type SweepNowAvailability,
  sweepNowAvailability,
} from '../state/sweepStatus';
import { commitLinesPerSweep } from './linesPerSweep';
import { leadClass } from './ProjectsLayout';

const noteClass = 'text-[0.95rem] leading-[1.45] text-pretty text-ink-soft';
const pathClass = 'font-mono text-[0.9em]';
const linkClass =
  'inline-flex items-center gap-[0.3rem] font-semibold text-wine hover:text-lipstick hover:underline hover:underline-offset-[0.2em] [&_svg]:flex-none';
const secondaryButtonClass =
  'inline-flex cursor-pointer items-center gap-[0.5em] rounded-pill border-2 border-petal bg-card px-5 py-[0.6rem] text-[1.05rem] font-bold text-wine transition-colors duration-150 not-disabled:hover:border-lipstick not-disabled:hover:text-lipstick disabled:cursor-default disabled:opacity-50 [&_svg]:size-[1em] [&_svg]:flex-none motion-reduce:transition-none';

const numberFormat = new Intl.NumberFormat();
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** A project whose sweep can be shown: CodeTinder's flow on it, and a default branch to sweep. */
type SweepableProject = ProjectWithState & {
  readonly consumerId: string;
  readonly defaultBranch: string;
};

const isSweepable = (project: ProjectWithState): project is SweepableProject =>
  project.consumerId !== null && project.defaultBranch !== null;

const GitLabLink = ({ url, children }: { readonly url: string; readonly children: ReactNode }) => (
  <a className={linkClass} href={url} target="_blank" rel="noreferrer">
    {children}
    <ArrowSquareOutIcon aria-hidden="true" />
  </a>
);

/** The sweep's own session in GitLab, only once GitLab has started it: nothing before then. */
const WatchSweepLink = ({ project }: { readonly project: SweepableProject }) => {
  const sessionResult = useAtomValue(sweepSessionAtom(project.id));
  const sessionUrl = Option.flatten(AsyncResult.value(sessionResult));
  if (Option.isNone(sessionUrl)) return null;
  return <GitLabLink url={sessionUrl.value}>Watch it in GitLab</GitLabLink>;
};

const linesSinceText = ({ count, isAtLeast }: LinesSince) =>
  `${numberFormat.format(count)}${isAtLeast ? '+' : ''} ${count === 1 && !isAtLeast ? 'line' : 'lines'} since`;

const openMergeRequestUrlOf = (last: ProjectSweep['last']): string | null => {
  if (last?.outcome._tag !== 'Proposed') return null;
  return Option.match(last.outcome.mergeRequest, {
    onNone: () => null,
    onSome: ({ url, isOpen }) => (isOpen ? url : null),
  });
};

const lastSweepText = (last: NonNullable<ProjectSweep['last']>): ReactNode => {
  const when = dateFormat.format(DateTime.toEpochMillis(last.at));
  if (last.outcome._tag === 'Clean') return `${when}, all in line, nothing to rewrite`;
  const { mergeRequestIid } = last.outcome;
  return Option.match(last.outcome.mergeRequest, {
    onNone: () => `${when}, in !${mergeRequestIid}`,
    onSome: ({ url, isOpen }) => (
      <>
        {when}, in <GitLabLink url={url}>!{mergeRequestIid}</GitLabLink>
        {isOpen && ', still open'}
      </>
    ),
  });
};

/** Why a sweep stopped, after "Last sweep stopped:". */
const STOP_CAUSE_TEXT: Record<SweepStopCause, string> = {
  Answer: 'CodeTinder’s answer didn’t check out',
  Tests: 'its rewrite didn’t pass your tests',
  Sandbox: 'your install or tests fail in CodeTinder’s sandbox',
  GitLab: 'GitLab turned its MR down',
  Error: 'CodeTinder tripped over an error',
};

/** A stopped sweep leaves the last one's commit alone, so the next sweeps what it didn't. */
const NEXT_SWEEP_UNMOVED = 'No hard feelings: the next one starts from the same spot.';

const stoppedText = ({ at, cause }: NonNullable<ProjectSweep['stopped']>): string => {
  const when = dateFormat.format(DateTime.toEpochMillis(at));
  return `Last sweep stopped, ${when}: ${STOP_CAUSE_TEXT[cause]}. ${NEXT_SWEEP_UNMOVED}`;
};

/** The last finished sweep, told apart from a stop since; nothing before any but a stop. */
const lastFactOf = ({ last, stopped }: ProjectSweep): ReactNode => {
  if (last === null && stopped === null) return 'No sweep yet';
  if (last === null) return null;
  const label = stopped === null ? 'Last sweep' : 'Last finished';
  return (
    <>
      {label}: {lastSweepText(last)}
    </>
  );
};

const carryOverText = (carryOver: number): string =>
  carryOver === 0
    ? 'Nothing carried over'
    : `${carryOver} ${carryOver === 1 ? 'function' : 'functions'} carried over`;

const waitReasonFor = ({
  canManageFlow,
  availability,
  watchLink,
}: {
  readonly canManageFlow: boolean;
  readonly availability: SweepNowAvailability;
  readonly watchLink: ReactNode;
}): ReactNode => {
  if (!canManageFlow) return 'Only someone allowed to manage this project’s flows can sweep.';
  switch (availability._tag) {
    case 'Ready':
      return null;
    case 'NeedsCi':
      return (
        <>
          Needs CI: this project has no <code className={pathClass}>.gitlab-ci.yml</code>, so
          there’s no pipeline for a sweep to start on.
        </>
      );
    case 'Running':
      return 'Hold that thought: a sweep is running right now.';
    case 'Starting':
      return (
        <>
          Sweep started. Any MR it opens turns up on GitLab in a few minutes, ready for a second
          look. {watchLink}
        </>
      );
    case 'MergeRequestOpen':
      return (
        <>
          Review <GitLabLink url={availability.url}>the open sweep</GitLabLink> first.
        </>
      );
    case 'NothingToSweep':
      return 'Nothing to sweep: no code changed since the last one, and nothing carried over.';
  }
};

/**
 * Lines per sweep, saved when committed: on leaving the field, which Enter does too, never while
 * typing. Escape puts back what it showed; a number a sweep can't take says why and saves nothing.
 */
const LinesPerSweepField = ({
  shown,
  isDisabled,
  branch,
  onCommit,
}: {
  /** The saved value, or the one a save in flight is writing. */
  readonly shown: number;
  readonly isDisabled: boolean;
  readonly branch: ReactNode;
  readonly onCommit: (threshold: number) => void;
}) => {
  // What the developer has typed since the field last showed `shown`; none until they type.
  const [typed, setTyped] = useState<{ readonly value: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Base UI keeps its own copy of typed text until the field is left; a fresh input drops it,
  // and takes the focus Escape was pressed in.
  const [inputKey, setInputKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputKey > 0) inputRef.current?.focus();
  }, [inputKey]);
  const putBack = () => {
    setTyped(null);
    setError(null);
    setInputKey(key => key + 1);
  };
  const commit = () => {
    if (typed === null) return;
    const commitment = commitLinesPerSweep({ typed: typed.value, shown });
    if (commitment._tag === 'Invalid') {
      setError(commitment.message);
      return;
    }
    setTyped(null);
    if (commitment._tag === 'Save') onCommit(commitment.threshold);
  };
  const shownText = numberFormat.format(shown);

  return (
    <Field.Root
      disabled={isDisabled}
      invalid={error !== null}
      className="grid gap-2 px-6 py-4 max-sm:px-5"
    >
      <Field.Label className="text-[1.1rem] font-semibold text-ink data-[disabled]:text-ink-faint">
        Lines per sweep
      </Field.Label>
      <NumberField.Root
        key={inputKey}
        name="threshold"
        value={typed === null ? shown : typed.value}
        onValueChange={value => {
          setTyped({ value });
          setError(null);
        }}
        step={100}
        largeStep={1000}
        disabled={isDisabled}
      >
        <NumberField.Input
          ref={inputRef}
          aria-label="Lines per sweep"
          onBlur={commit}
          onKeyDown={({ key, currentTarget }) => {
            if (key === 'Enter') currentTarget.blur();
            if (key === 'Escape') putBack();
          }}
          className="h-9 w-[8ch] rounded-[8px] border border-petal bg-card px-2 text-right font-semibold text-ink tabular-nums focus:outline-2 focus:outline-offset-1 focus:outline-lipstick data-[disabled]:text-ink-faint data-[invalid]:border-lipstick"
        />
      </NumberField.Root>
      {error !== null && (
        <Field.Error match className="text-[0.95rem] leading-[1.45] font-semibold text-wine">
          {error}
        </Field.Error>
      )}
      <Field.Description className={noteClass}>
        The first sweep takes the latest {shownText} lines of code changed on {branch}; with
        automatic sweeping on, the next starts once {shownText} more have changed.
      </Field.Description>
    </Field.Root>
  );
};

/**
 * The sweep's settings and status in one card: the settings in its body, each saved as it is
 * set, and where the sweep stands and Sweep now in its footer.
 */
const SweepPanel = ({
  project,
  sweep,
  savedIsAutomatic,
  hasCiConfig,
}: {
  readonly project: SweepableProject;
  readonly sweep: ProjectSweep;
  readonly savedIsAutomatic: boolean;
  readonly hasCiConfig: boolean;
}) => {
  const [saveResult, saveSetting] = useAtom(saveSweepSettingAtom);
  const [sweepResult, sweepNow] = useAtom(sweepNowAtom);
  // What the saves in flight write, shown until the last ends; a new run of saves starts afresh.
  const [pending, setPending] = useState<{
    readonly threshold?: number;
    readonly isAutomatic?: boolean;
  }>({});
  const isSaving = saveResult.waiting;
  const inFlight = isSaving ? pending : {};
  const shownThreshold = inFlight.threshold ?? sweep.threshold;
  // Without CI no pipeline passes on the default branch, so automatic sweeping is shown off.
  const isShownAutomatic = hasCiConfig && (inFlight.isAutomatic ?? savedIsAutomatic);
  const save = (setting: SweepSetting) => {
    setPending({
      ...inFlight,
      ...(setting._tag === 'Threshold'
        ? { threshold: setting.threshold }
        : { isAutomatic: setting.isAutomatic }),
    });
    saveSetting({
      projectId: project.id,
      projectFullPath: project.fullPath,
      consumerId: project.consumerId,
      defaultBranch: project.defaultBranch,
      setting,
    });
  };
  const { last, stopped } = sweep;
  const availability = sweepNowAvailability({
    hasCiConfig,
    isRunning: sweep.isRunning,
    isStarting: sweep.isStarting,
    openMergeRequestUrl: openMergeRequestUrlOf(last),
    linesSince: sweep.linesSince,
    carryOver: sweep.carryOver,
  });
  const isDisabled = !project.canManageFlow || !hasCiConfig;
  const branch = <code className={pathClass}>{project.defaultBranch}</code>;
  const watchLink = <WatchSweepLink project={project} />;
  const waitReason = waitReasonFor({
    canManageFlow: project.canManageFlow,
    availability,
    watchLink,
  });
  const lastFact = lastFactOf(sweep);
  const facts = [
    ...(lastFact === null ? [] : [{ id: 'last', node: lastFact }]),
    ...(sweep.linesSince === null ? [] : [{ id: 'since', node: linesSinceText(sweep.linesSince) }]),
    ...(last === null ? [] : [{ id: 'carried', node: carryOverText(sweep.carryOver) }]),
  ];

  return (
    <>
      <LinesPerSweepField
        shown={shownThreshold}
        isDisabled={isDisabled}
        branch={branch}
        onCommit={threshold => save({ _tag: 'Threshold', threshold })}
      />
      <Field.Root
        disabled={isDisabled}
        className="grid gap-1 border-t border-rule px-6 py-4 max-sm:px-5"
      >
        <Field.Label className="flex min-h-11 cursor-pointer items-center gap-4 text-[1.1rem] font-semibold text-ink data-[disabled]:cursor-default data-[disabled]:text-ink-faint">
          <Checkbox.Root
            checked={isShownAutomatic}
            onCheckedChange={isAutomatic => save({ _tag: 'Automatic', isAutomatic })}
            className="flex size-[1.4rem] flex-none items-center justify-center rounded-[7px] border-2 border-petal bg-card text-white transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lipstick data-[checked]:border-lipstick data-[checked]:bg-lipstick data-[disabled]:opacity-50 motion-reduce:transition-none"
          >
            <Checkbox.Indicator className="flex data-[unchecked]:hidden">
              <CheckIcon weight="bold" className="size-[0.95rem]" aria-hidden="true" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          Sweep automatically
        </Field.Label>
        <Field.Description className={cn(noteClass, 'pl-[2.4rem]')}>
          Each merge to {branch} then starts a short CodeTinder run to count, billed to your GitLab
          credits and runner minutes; it sweeps once enough has changed.
        </Field.Description>
        {!hasCiConfig && (
          <Field.Description className={cn(noteClass, 'pl-[2.4rem] font-semibold text-wine')}>
            Needs CI: this project has no <code className={pathClass}>.gitlab-ci.yml</code>, so a
            merge starts no pipeline for CodeTinder to hear.
          </Field.Description>
        )}
      </Field.Root>
      <footer className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-rule bg-card-sunk px-6 py-4 max-sm:px-5">
        <div className={cn(noteClass, 'grid min-w-0 grow basis-full gap-1 sm:basis-0')}>
          {sweep.isRunning && (
            <p className="flex items-center gap-2 font-semibold text-wine">
              <HeartIcon
                weight="fill"
                className="size-[1.1em] animate-beat text-hot-pink motion-reduce:animate-none"
                aria-hidden="true"
              />
              Sweeping now… {watchLink}
            </p>
          )}
          {stopped !== null && <p>{stoppedText(stopped)}</p>}
          <p>
            {facts.map(({ id, node }, index) => (
              <Fragment key={id}>
                {index > 0 && ' · '}
                {node}
              </Fragment>
            ))}
          </p>
          {waitReason && <p role="status">{waitReason}</p>}
        </div>
        {project.canManageFlow && (
          <button
            type="button"
            className={cn(secondaryButtonClass, 'max-sm:ml-auto')}
            disabled={availability._tag !== 'Ready' || isSaving || sweepResult.waiting}
            onClick={() =>
              sweepNow({
                projectId: project.id,
                projectFullPath: project.fullPath,
                consumerId: project.consumerId,
                defaultBranch: project.defaultBranch,
                lastEndedAtMs: lastEndedAtMs(sweep),
              })
            }
          >
            <BroomIcon weight="bold" aria-hidden="true" />
            {sweepResult.waiting ? 'Starting…' : 'Sweep now'}
          </button>
        )}
      </footer>
    </>
  );
};

const Notice = ({ children }: { readonly children: ReactNode }) => (
  <p className={cn(noteClass, 'px-6 py-5 max-sm:px-5')}>{children}</p>
);

const SweepCard = ({ project }: { readonly project: SweepableProject }) =>
  AsyncResult.builder(
    AsyncResult.all({
      triggers: useAtomValue(flowTriggersAtom(project.id)),
      sweep: useAtomValue(sweepAtom(project.id)),
    }),
  )
    .onInitial(() => <Notice>Reading the sweep…</Notice>)
    .onSuccess(({ triggers, sweep }) => {
      if (Option.isNone(triggers.round)) {
        return (
          <Notice>
            No sweep here: this project’s CodeTinder trigger was deleted in GitLab. Remove
            CodeTinder and add it again to get a new one.
          </Notice>
        );
      }
      // Two triggers only when two writes raced; any one sweeping on every merge makes it on.
      const savedIsAutomatic = triggers.sweeps.some(({ isAutomatic }) => isAutomatic);
      return (
        <SweepPanel
          project={project}
          sweep={sweep}
          savedIsAutomatic={savedIsAutomatic}
          hasCiConfig={triggers.hasCiConfig}
        />
      );
    })
    .onFailure(() => <Notice>Couldn’t read the sweep. Reload to try again.</Notice>)
    .render();

/**
 * The project's sweep: what it is for, where it stands, the settings it sweeps by, and Sweep now.
 */
export const SweepSection = ({ project }: { readonly project: ProjectWithState }) => {
  const { state } = project;
  if (state._tag !== 'Live' || !isSweepable(project)) return null;
  return (
    <section className="mt-[clamp(2.5rem,7vw,4rem)]" aria-labelledby="sweep-title">
      <h2
        id="sweep-title"
        className="font-display text-[clamp(1.75rem,1.3rem_+_1.2vw,2.5rem)] leading-[1.1] font-bold text-balance text-candy-red text-shadow-emboss"
      >
        Sweep
      </h2>
      <p className={leadClass}>
        Between rounds, code drifts from your type. A sweep wins it back: up to 20 functions that
        stray from your principles, rewritten in one MR for you to review.
      </p>
      <article className="overflow-hidden rounded-[16px] bg-card shadow-card">
        {canFlowSweep(state.version) ? (
          <SweepCard project={project} />
        ) : (
          <Notice>
            Sweeping needs CodeTinder {SWEEP_FLOW_VERSION} or later, and this project is on{' '}
            {state.version ?? 'an older one'}.{' '}
            {state.updateTo !== null && canFlowSweep(state.updateTo)
              ? 'Update it above, then sweep away.'
              : 'Update it once that’s out.'}
          </Notice>
        )}
      </article>
    </section>
  );
};
