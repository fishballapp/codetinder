import { AskIdSchema } from '@codetinder/api';
import * as DateTime from 'effect/DateTime';
import * as Duration from 'effect/Duration';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import {
  applyReport,
  askToLearn,
  LEARN_RUN_TIMEOUT,
  LEARN_START_TIMEOUT,
  type LearnAsk,
  learnState,
  retryLearn,
  tieNote,
} from './learn';
import { sampleAsk } from './test-fixtures';

const ASKED_MS = DateTime.toEpochMillis(sampleAsk.askedAt);
const NEW_ID = Schema.decodeSync(AskIdSchema)('16fd2706-8baf-433b-82eb-8c7fada847da');
const START_DEADLINE_MS = ASKED_MS + Duration.toMillis(LEARN_START_TIMEOUT);
const started: LearnAsk = { ...sampleAsk, startedAt: DateTime.makeUnsafe(ASKED_MS + 60_000) };

const stateOf = (ask: LearnAsk | null, nowMs: number) =>
  learnState({ ask, swipes: sampleAsk.swipes, nowMs });

describe('learnState', () => {
  it('reads no ask, or one for other swipes, as not learned', () => {
    expect(stateOf(null, ASKED_MS)).toEqual({ _tag: 'NotLearned' });
    expect(learnState({ ask: sampleAsk, swipes: '[]', nowMs: ASKED_MS })).toEqual({
      _tag: 'NotLearned',
    });
  });

  it('reads an ask as learning until GitLab has had its time to start it', () => {
    expect(stateOf(sampleAsk, START_DEADLINE_MS - 1)).toEqual({
      _tag: 'Learning',
      askId: sampleAsk.id,
      isRetry: false,
    });
    expect(stateOf(sampleAsk, START_DEADLINE_MS)).toEqual({
      _tag: 'Unfinished',
      askId: sampleAsk.id,
      isRetry: false,
      reason: 'NotStarted',
      isSettled: false,
    });
  });

  it('settles an unstarted or stalled ask once no run could still report on it', () => {
    const lastReport = START_DEADLINE_MS + Duration.toMillis(LEARN_RUN_TIMEOUT);
    expect(stateOf(sampleAsk, lastReport - 1)).toMatchObject({ isSettled: false });
    expect(stateOf(sampleAsk, lastReport)).toMatchObject({ isSettled: true });
    const stalledUntil = ASKED_MS + 60_000 + Duration.toMillis(LEARN_RUN_TIMEOUT);
    expect(stateOf(started, stalledUntil)).toMatchObject({ reason: 'Stalled', isSettled: true });
  });

  it('gives a started run its whole time to finish, then reads it as stalled', () => {
    const deadline = ASKED_MS + 60_000 + Duration.toMillis(LEARN_RUN_TIMEOUT);
    expect(stateOf(started, deadline - 1)._tag).toBe('Learning');
    expect(stateOf(started, deadline)).toMatchObject({ _tag: 'Unfinished', reason: 'Stalled' });
  });

  it("reads the run's end, whenever it came", () => {
    const at = DateTime.makeUnsafe(ASKED_MS + 120_000);
    const late = START_DEADLINE_MS + Duration.toMillis(LEARN_RUN_TIMEOUT);
    expect(stateOf({ ...started, ended: { at, outcome: 'Finished' } }, late)).toEqual({
      _tag: 'Learned',
    });
    expect(stateOf({ ...started, ended: { at, outcome: 'Failed' } }, ASKED_MS)).toMatchObject({
      _tag: 'Unfinished',
      reason: 'Failed',
      isSettled: true,
    });
  });
});

describe('askToLearn', () => {
  const input = (ask: LearnAsk | null, nowMs = ASKED_MS) => ({
    ask,
    swipes: sampleAsk.swipes,
    nowMs,
  });

  it('asks for swipes no run has learned or is learning', () => {
    const { result, next } = askToLearn(input(null), NEW_ID);
    expect(result).toEqual({ _tag: 'Asked', askId: NEW_ID });
    expect(next).toEqual({
      id: NEW_ID,
      swipes: sampleAsk.swipes,
      askedAt: sampleAsk.askedAt,
      isRetry: false,
      noteId: null,
      startedAt: null,
      ended: null,
    });
  });

  it('refuses swipes a run is learning or has learned', () => {
    expect(askToLearn(input(sampleAsk), NEW_ID)).toEqual({
      result: { _tag: 'AlreadyLearning' },
      next: null,
    });
    const finished: LearnAsk = {
      ...started,
      ended: { at: sampleAsk.askedAt, outcome: 'Finished' },
    };
    expect(askToLearn(input(finished), NEW_ID)).toEqual({
      result: { _tag: 'AlreadyLearned' },
      next: null,
    });
  });

  it('asks again for swipes whose run did not finish', () => {
    expect(askToLearn(input(sampleAsk, START_DEADLINE_MS), NEW_ID).result).toEqual({
      _tag: 'Asked',
      askId: NEW_ID,
    });
  });
});

describe('retryLearn', () => {
  const retry = (ask: LearnAsk, askId = sampleAsk.id, nowMs = START_DEADLINE_MS) =>
    retryLearn({ ask, swipes: sampleAsk.swipes, nowMs }, { askId, id: NEW_ID });

  it('asks again, once, for the latest ask GitLab never started', () => {
    const { result, next } = retry(sampleAsk);
    expect(result).toBe(NEW_ID);
    expect(next).toMatchObject({ id: NEW_ID, isRetry: true, noteId: null });
    if (next === null) throw new Error('expected an ask');
    expect(retry(next, NEW_ID, START_DEADLINE_MS * 2)).toEqual({ result: null, next: null });
  });

  it('refuses an ask that may still start, has started, or is not the latest', () => {
    expect(retry(sampleAsk, sampleAsk.id, START_DEADLINE_MS - 1).result).toBeNull();
    expect(retry(started).result).toBeNull();
    expect(retry(sampleAsk, NEW_ID).result).toBeNull();
  });
});

describe('tieNote', () => {
  const unbound: LearnAsk = { ...sampleAsk, noteId: null };
  const tie = (ask: LearnAsk, askId = sampleAsk.id) =>
    tieNote({ ask, swipes: sampleAsk.swipes, nowMs: ASKED_MS }, { askId, noteId: 901 }).next;

  it('ties the latest ask to its reply, once', () => {
    expect(tie(unbound)).toEqual({ ...unbound, noteId: 901 });
    expect(tie(sampleAsk)).toBeNull();
    expect(tie(unbound, NEW_ID)).toBeNull();
  });
});

describe('applyReport', () => {
  const apply = (ask: LearnAsk, report: 'Started' | 'Finished' | 'Failed', noteId = 900) =>
    applyReport({ ask, swipes: sampleAsk.swipes, nowMs: ASKED_MS + 60_000 }, { noteId, report })
      .next;

  it("applies the reports of the ask's own run", () => {
    expect(apply(sampleAsk, 'Started')).toEqual(started);
    expect(apply(started, 'Finished')).toEqual({
      ...started,
      ended: { at: started.startedAt, outcome: 'Finished' },
    });
  });

  it("ignores another ask's run, a second start and anything after the end", () => {
    expect(apply(sampleAsk, 'Finished', 901)).toBeNull();
    expect(apply({ ...sampleAsk, noteId: null }, 'Started')).toBeNull();
    expect(apply(started, 'Started')).toBeNull();
    const ended: LearnAsk = { ...started, ended: { at: sampleAsk.askedAt, outcome: 'Failed' } };
    expect(apply(ended, 'Finished')).toBeNull();
  });
});
