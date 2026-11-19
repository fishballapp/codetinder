import type { SweepStopCause } from '@codetinder/api';
import { isNotCode, sweepLineCount } from '@codetinder/core';
import type { ComparedFile } from '@codetinder/gitlab';
import * as DateTime from 'effect/DateTime';
import type * as Option from 'effect/Option';

/** A project's sweep as its page shows it. */
export type ProjectSweep = {
  readonly threshold: number;
  /** The last sweep that finished; none before the first. */
  readonly last: {
    readonly at: DateTime.Utc;
    readonly outcome:
      | { readonly _tag: 'Clean' }
      | {
          readonly _tag: 'Proposed';
          readonly mergeRequestIid: number;
          /** None when the MR is gone from GitLab. */
          readonly mergeRequest: Option.Option<{ readonly url: string; readonly isOpen: boolean }>;
        };
  } | null;
  /** The latest sweep, when it stopped short since `last`. */
  readonly stopped: { readonly at: DateTime.Utc; readonly cause: SweepStopCause } | null;
  /** Lines of code changed on the default branch since the last sweep; none before the first. */
  readonly linesSince: LinesSince | null;
  /** How many functions the last sweep left for the next. */
  readonly carryOver: number;
  readonly isRunning: boolean;
  /** Sweep now was pressed and no sweep has shown up since, for up to `SWEEP_START_WAIT_MS`. */
  readonly isStarting: boolean;
};

/**
 * How long a Sweep now waits to show up. A sweep is claimed only once its pipeline passes, which
 * takes minutes; past this the pipeline is taken to have failed and Sweep now is offered again.
 */
export const SWEEP_START_WAIT_MS = 15 * 60 * 1000;

/** How often the page reads the sweep again while one is starting or running. */
export const SWEEP_POLL_INTERVAL = '30 seconds';

/** When the latest sweep ended, finished or stopped; none before the first. */
export const lastEndedAtMs = ({
  last,
  stopped,
}: {
  readonly last: { readonly at: DateTime.Utc } | null;
  readonly stopped: { readonly at: DateTime.Utc } | null;
}): number | null => {
  const ended = stopped ?? last;
  return ended === null ? null : DateTime.toEpochMillis(ended.at);
};

/** A Sweep now the developer pressed: when, and when the latest sweep before it ended. */
export type SweepStart = { readonly atMs: number; readonly lastEndedAtMs: number | null };

/**
 * Whether a Sweep now is still on its way: nothing has claimed the sweep and no sweep has ended
 * since it was pressed, and it was pressed recently enough.
 */
export const isSweepStarting = ({
  start,
  isRunning,
  lastEndedAtMs,
  nowMs,
}: {
  readonly start: SweepStart | null;
  readonly isRunning: boolean;
  readonly lastEndedAtMs: number | null;
  readonly nowMs: number;
}): boolean =>
  start !== null &&
  !isRunning &&
  lastEndedAtMs === start.lastEndedAtMs &&
  nowMs - start.atMs < SWEEP_START_WAIT_MS;

/** Lines of code changed since the last sweep; `isAtLeast` when GitLab left some uncounted. */
export type LinesSince = { readonly count: number; readonly isAtLeast: boolean };

/**
 * The lines a comparison adds to code files. A code file whose diff GitLab withheld, or a
 * comparison it stopped short, makes the count a floor.
 */
export const linesSince = ({
  files,
  isTruncated,
}: {
  readonly files: readonly ComparedFile[];
  readonly isTruncated: boolean;
}): LinesSince => ({
  count: sweepLineCount(files),
  isAtLeast: isTruncated || files.some(file => file.isTruncated && !isNotCode(file.path)),
});

/** Whether Sweep now can start a sweep, and if not, why. */
export type SweepNowAvailability =
  | { readonly _tag: 'Ready' }
  | { readonly _tag: 'NeedsCi' }
  | { readonly _tag: 'Running' }
  | { readonly _tag: 'Starting' }
  | { readonly _tag: 'MergeRequestOpen'; readonly url: string }
  | { readonly _tag: 'NothingToSweep' };

/**
 * Sweep now waits for a run sweeping now, for one it started to show up, and for the last
 * sweep's MR to be reviewed, and has
 * nothing to do when no code changed since the last sweep and none carried over. It needs a
 * pipeline on the default branch, so CI. Before the first sweep there is always the latest code
 * changed to take.
 */
export const sweepNowAvailability = ({
  hasCiConfig,
  isRunning,
  isStarting,
  openMergeRequestUrl,
  linesSince,
  carryOver,
}: {
  readonly hasCiConfig: boolean;
  readonly isRunning: boolean;
  readonly isStarting: boolean;
  /** The last sweep's MR, while it is open. */
  readonly openMergeRequestUrl: string | null;
  /** None before the first sweep. */
  readonly linesSince: LinesSince | null;
  readonly carryOver: number;
}): SweepNowAvailability => {
  if (!hasCiConfig) return { _tag: 'NeedsCi' };
  if (isRunning) return { _tag: 'Running' };
  if (isStarting) return { _tag: 'Starting' };
  if (openMergeRequestUrl !== null) return { _tag: 'MergeRequestOpen', url: openMergeRequestUrl };
  const hasChanges =
    linesSince === null || linesSince.count > 0 || linesSince.isAtLeast || carryOver > 0;
  return hasChanges ? { _tag: 'Ready' } : { _tag: 'NothingToSweep' };
};
