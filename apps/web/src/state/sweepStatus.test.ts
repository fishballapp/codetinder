import * as DateTime from 'effect/DateTime';
import { describe, expect, it } from 'vitest';
import {
  isSweepStarting,
  lastEndedAtMs,
  linesSince,
  SWEEP_START_WAIT_MS,
  sweepNowAvailability,
} from './sweepStatus';

describe('linesSince', () => {
  it('counts the lines added to code files', () => {
    expect(
      linesSince({
        files: [
          { path: 'src/cart.ts', addedLines: 40, isTruncated: false },
          { path: 'README.md', addedLines: 300, isTruncated: false },
          { path: 'src/total.ts', addedLines: 2, isTruncated: false },
        ],
        isTruncated: false,
      }),
    ).toEqual({ count: 42, isAtLeast: false });
  });

  it('is a floor when a code file’s diff was withheld, or the comparison stopped short', () => {
    const withheld = { path: 'src/big.ts', addedLines: 0, isTruncated: true };
    expect(linesSince({ files: [withheld], isTruncated: false })).toEqual({
      count: 0,
      isAtLeast: true,
    });
    expect(linesSince({ files: [], isTruncated: true })).toEqual({ count: 0, isAtLeast: true });
  });

  it('ignores a withheld lockfile, which never counts', () => {
    const lockfile = { path: 'pnpm-lock.yaml', addedLines: 0, isTruncated: true };
    expect(linesSince({ files: [lockfile], isTruncated: false })).toEqual({
      count: 0,
      isAtLeast: false,
    });
  });
});

describe('sweepNowAvailability', () => {
  const ready = {
    hasCiConfig: true,
    isRunning: false,
    isStarting: false,
    openMergeRequestUrl: null,
    linesSince: { count: 120, isAtLeast: false },
    carryOver: 0,
  };
  const NOTHING_CHANGED = { count: 0, isAtLeast: false };

  it('is ready when code changed since the last sweep, or functions carried over', () => {
    expect(sweepNowAvailability(ready)).toEqual({ _tag: 'Ready' });
    expect(sweepNowAvailability({ ...ready, linesSince: NOTHING_CHANGED, carryOver: 3 })).toEqual({
      _tag: 'Ready',
    });
    expect(sweepNowAvailability({ ...ready, linesSince: { count: 0, isAtLeast: true } })).toEqual({
      _tag: 'Ready',
    });
  });

  it('is ready before the first sweep', () => {
    expect(sweepNowAvailability({ ...ready, linesSince: null })).toEqual({ _tag: 'Ready' });
  });

  it('has nothing to sweep when no code changed and nothing carried over', () => {
    expect(sweepNowAvailability({ ...ready, linesSince: NOTHING_CHANGED })).toEqual({
      _tag: 'NothingToSweep',
    });
  });

  it('waits for a sweep running now, and for the last sweep’s open MR', () => {
    expect(sweepNowAvailability({ ...ready, isRunning: true })).toEqual({ _tag: 'Running' });
    const url = 'https://gitlab.com/g/p/-/merge_requests/7';
    expect(sweepNowAvailability({ ...ready, openMergeRequestUrl: url })).toEqual({
      _tag: 'MergeRequestOpen',
      url,
    });
  });

  it('waits for a Sweep now on its way, so a second press starts no second run', () => {
    expect(sweepNowAvailability({ ...ready, isStarting: true })).toEqual({ _tag: 'Starting' });
  });

  it('needs CI, whatever else holds', () => {
    expect(
      sweepNowAvailability({ ...ready, hasCiConfig: false, isRunning: true, linesSince: null }),
    ).toEqual({ _tag: 'NeedsCi' });
  });
});

describe('lastEndedAtMs', () => {
  const at = (iso: string) => DateTime.makeUnsafe(iso);
  const last = { at: at('2026-10-10T00:00:00Z') };

  it('is when the latest sweep ended: a stop after the last finished one, else that one', () => {
    expect(lastEndedAtMs({ last: null, stopped: null })).toBeNull();
    expect(lastEndedAtMs({ last, stopped: null })).toBe(DateTime.toEpochMillis(last.at));
    expect(lastEndedAtMs({ last, stopped: { at: at('2026-10-16T00:00:00Z') } })).toBe(
      DateTime.toEpochMillis(at('2026-10-16T00:00:00Z')),
    );
  });
});

describe('isSweepStarting', () => {
  const pressedAt = 1_000_000;
  const start = { atMs: pressedAt, lastEndedAtMs: 500 };
  const waiting = { start, isRunning: false, lastEndedAtMs: 500, nowMs: pressedAt + 60_000 };

  it('is starting from the press until something shows up', () => {
    expect(isSweepStarting(waiting)).toBe(true);
    expect(
      isSweepStarting({
        ...waiting,
        start: { atMs: pressedAt, lastEndedAtMs: null },
        lastEndedAtMs: null,
      }),
    ).toBe(true);
  });

  it('ends once a run claims the sweep, or a new sweep finishes or stops', () => {
    expect(isSweepStarting({ ...waiting, isRunning: true })).toBe(false);
    expect(isSweepStarting({ ...waiting, lastEndedAtMs: 900 })).toBe(false);
    expect(
      isSweepStarting({
        ...waiting,
        start: { atMs: pressedAt, lastEndedAtMs: null },
        lastEndedAtMs: 900,
      }),
    ).toBe(false);
  });

  it('gives up after the wait, so a pipeline that failed leaves Sweep now usable', () => {
    expect(isSweepStarting({ ...waiting, nowMs: pressedAt + SWEEP_START_WAIT_MS - 1 })).toBe(true);
    expect(isSweepStarting({ ...waiting, nowMs: pressedAt + SWEEP_START_WAIT_MS })).toBe(false);
  });

  it('is not starting when Sweep now was never pressed', () => {
    expect(isSweepStarting({ ...waiting, start: null })).toBe(false);
  });
});
