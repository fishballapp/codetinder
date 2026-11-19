import type { LearnState } from '@codetinder/api';
import * as Exit from 'effect/Exit';

/** How often the round's page reads where learning stands while it may still change. */
export const LEARN_POLL_INTERVAL = '20 seconds';

/**
 * Whether the page reads the learn state again: while a run learns, while one that didn't finish
 * may still report (a late start or end), and after a read that failed, so one lost answer never
 * stops the page following the run.
 */
export const shouldPollLearn = (read: Exit.Exit<LearnState, unknown>): boolean => {
  if (Exit.isFailure(read)) return true;
  const learn = read.value;
  if (learn._tag === 'Learning') return true;
  return learn._tag === 'Unfinished' && !learn.isSettled;
};
