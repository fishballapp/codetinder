import {
  type AskId,
  AskIdSchema,
  type DeveloperSwipes,
  type LearnReport,
  type LearnState,
  type UnfinishedReason,
} from '@codetinder/api';
import type { Verdicts } from '@codetinder/core';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Schema from 'effect/Schema';

/**
 * How long GitLab gets to start an ask's learn run. Its first step, `route`, reports the start; a
 * mention starts a session within seconds and its first output comes about a minute later, so
 * five minutes is a dropped ask, not a slow one.
 */
export const LEARN_START_TIMEOUT = Duration.minutes(5);

/**
 * How long a started learn run gets to finish: its steps' own timeouts add up to 87 minutes (two
 * 30-minute test runs, three agents, the rest), plus a margin.
 */
export const LEARN_RUN_TIMEOUT = Duration.minutes(100);

/** One Done's ask to learn the round's swipes, and how its learn run went. */
export const LearnAskSchema = Schema.Struct({
  id: AskIdSchema,
  /** The swipes it asked to learn, as `swipesSnapshot` writes them. */
  swipes: Schema.String,
  askedAt: Schema.DateTimeUtc,
  /** Whether a page asked again by itself after GitLab never started the ask before it. */
  isRetry: Schema.Boolean,
  /** The reply that asked, whose learn run's reports apply; none until the page tied it. */
  noteId: Schema.NullOr(Schema.Int),
  startedAt: Schema.NullOr(Schema.DateTimeUtc),
  ended: Schema.NullOr(
    Schema.Struct({ at: Schema.DateTimeUtc, outcome: Schema.Literals(['Finished', 'Failed']) }),
  ),
});
export type LearnAsk = typeof LearnAskSchema.Type;

/** A developer's verdicts as [card id, verdict] pairs, sorted by card id. */
const sortedVerdictPairs = (verdicts: Verdicts) =>
  Object.keys(verdicts)
    .toSorted()
    .map(cardId => [cardId, verdicts[cardId]]);

/**
 * Every developer's verdicts as one string, with the developers and the cards each sorted, so equal
 * swipes give equal strings whatever order they were swiped in. A developer who undid every swipe
 * is left out, the same as one who never swiped.
 */
export const swipesSnapshot = (swipes: readonly DeveloperSwipes[]): string => {
  const swiping = swipes.filter(({ verdicts }) => Object.keys(verdicts).length > 0);
  const byUser = swiping.toSorted((left, right) => left.userId - right.userId);
  return JSON.stringify(
    byUser.map(({ userId, verdicts }) => [userId, sortedVerdictPairs(verdicts)]),
  );
};

const isPast = (since: DateTime.Utc, timeout: Duration.Duration, nowMs: number): boolean =>
  nowMs - DateTime.toEpochMillis(since) >= Duration.toMillis(timeout);

/** What a decision reads, and the state is judged from: the round's latest ask, its swipes now, and the time. */
export type LearnInput = {
  readonly ask: LearnAsk | null;
  readonly swipes: string;
  readonly nowMs: number;
};

/** Where learning the round's swipes, as they are now, stands. */
export const learnState = ({ ask, swipes, nowMs }: LearnInput): LearnState => {
  if (ask === null || ask.swipes !== swipes) return { _tag: 'NotLearned' };
  // The latest a run could still report: a start at the start deadline, then its whole run.
  const lastStartMs =
    ask.startedAt === null
      ? DateTime.toEpochMillis(ask.askedAt) + Duration.toMillis(LEARN_START_TIMEOUT)
      : DateTime.toEpochMillis(ask.startedAt);
  const isPastLastReport = nowMs >= lastStartMs + Duration.toMillis(LEARN_RUN_TIMEOUT);
  const unfinished = (reason: UnfinishedReason): LearnState => ({
    _tag: 'Unfinished',
    askId: ask.id,
    isRetry: ask.isRetry,
    reason,
    isSettled: reason === 'Failed' || isPastLastReport,
  });
  if (ask.ended?.outcome === 'Finished') return { _tag: 'Learned' };
  if (ask.ended?.outcome === 'Failed') return unfinished('Failed');
  if (ask.startedAt === null && isPast(ask.askedAt, LEARN_START_TIMEOUT, nowMs)) {
    return unfinished('NotStarted');
  }
  if (ask.startedAt !== null && isPast(ask.startedAt, LEARN_RUN_TIMEOUT, nowMs)) {
    return unfinished('Stalled');
  }
  return { _tag: 'Learning', askId: ask.id, isRetry: ask.isRetry };
};

/** What a decision on the round's ask leaves: its answer, and the ask to write, or none. */
export type Decision<A> = { readonly result: A; readonly next: LearnAsk | null };

const newAsk = ({
  id,
  swipes,
  nowMs,
  isRetry,
}: {
  readonly id: AskId;
  readonly swipes: string;
  readonly nowMs: number;
  readonly isRetry: boolean;
}): LearnAsk => ({
  id,
  swipes,
  askedAt: DateTime.makeUnsafe(nowMs),
  isRetry,
  noteId: null,
  startedAt: null,
  ended: null,
});

/**
 * A Done: a new ask for the swipes as they are, unless a run has learned them or is learning
 * them. One that didn't finish is asked again, so Done reads "Learn again".
 */
export const askToLearn = (
  input: LearnInput,
  id: AskId,
): Decision<
  | { readonly _tag: 'Asked'; readonly askId: AskId }
  | { readonly _tag: 'AlreadyLearned' }
  | { readonly _tag: 'AlreadyLearning' }
> => {
  const state = learnState(input);
  if (state._tag === 'Learned') return { result: { _tag: 'AlreadyLearned' }, next: null };
  if (state._tag === 'Learning') return { result: { _tag: 'AlreadyLearning' }, next: null };
  return {
    result: { _tag: 'Asked', askId: id },
    next: newAsk({ id, swipes: input.swipes, nowMs: input.nowMs, isRetry: false }),
  };
};

/**
 * A page asking again by itself, once: only for the latest ask, GitLab never having started it,
 * and only if that ask wasn't itself asked again. Of two pages asking, the first gets it.
 */
export const retryLearn = (
  input: LearnInput,
  { askId, id }: { readonly askId: AskId; readonly id: AskId },
): Decision<AskId | null> => {
  const state = learnState(input);
  const isDue =
    state._tag === 'Unfinished' &&
    state.reason === 'NotStarted' &&
    state.askId === askId &&
    !state.isRetry;
  if (!isDue) return { result: null, next: null };
  return {
    result: id,
    next: newAsk({ id, swipes: input.swipes, nowMs: input.nowMs, isRetry: true }),
  };
};

/** Ties the latest ask to the reply that asked, once; anything else is left as it is. */
export const tieNote = (
  { ask }: LearnInput,
  { askId, noteId }: { readonly askId: AskId; readonly noteId: number },
): Decision<void> => {
  if (ask === null || ask.id !== askId || ask.noteId !== null) {
    return { result: undefined, next: null };
  }
  return { result: undefined, next: { ...ask, noteId } };
};

/**
 * A learn run's report, applied to the latest ask only when the run answers its reply: a run of an
 * ask since superseded changes nothing. A start after the end, or a second end, changes nothing
 * either, so duplicate sessions of one mention and retried reports agree.
 */
export const applyReport = (
  { ask, nowMs }: LearnInput,
  { noteId, report }: { readonly noteId: number; readonly report: LearnReport },
): Decision<void> => {
  const unchanged = { result: undefined, next: null };
  if (ask === null || ask.noteId !== noteId || ask.ended !== null) return unchanged;
  const at = DateTime.makeUnsafe(nowMs);
  if (report === 'Started') {
    return ask.startedAt === null
      ? { result: undefined, next: { ...ask, startedAt: at } }
      : unchanged;
  }
  // ponytail: the run learns the swipes it reads when its task is written, not the ask's snapshot,
  // so a swipe between the ask and that read is learned under the older snapshot's Learned ✓. Rare.
  return { result: undefined, next: { ...ask, ended: { at, outcome: report } } };
};
