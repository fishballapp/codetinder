import { type AskId, AskIdSchema, type LearnState } from '@codetinder/api';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { askToRepeat, doneState, learnLine } from './doneState';

const ASK: AskId = Schema.decodeSync(AskIdSchema)('7c9e6679-7425-40de-944b-e07fc1f90ae7');
const notLearned: LearnState = { _tag: 'NotLearned' };
const ready = { isSending: false, learn: notLearned, isLearnUnreadable: false, isReady: true };
const learning: LearnState = { _tag: 'Learning', askId: ASK, isRetry: false };
const unstarted: LearnState = {
  _tag: 'Unfinished',
  askId: ASK,
  isRetry: false,
  reason: 'NotStarted',
  isSettled: false,
};

describe('doneState', () => {
  it('reads Done and can be pressed once the round has a swipe and its MR', () => {
    expect(doneState(ready)).toEqual({ label: 'Done', canFinish: true, hasHeart: true });
  });

  it('cannot be pressed before the round is ready, or its learn state has loaded', () => {
    expect(doneState({ ...ready, isReady: false }).canFinish).toBe(false);
    expect(doneState({ ...ready, learn: undefined }).canFinish).toBe(false);
  });

  it('reads Learning… and Learned ✓, disabled, while a run learns these swipes and once it has', () => {
    expect(doneState({ ...ready, learn: learning })).toEqual({
      label: 'Learning…',
      canFinish: false,
      hasHeart: false,
    });
    expect(doneState({ ...ready, learn: { _tag: 'Learned' } })).toEqual({
      label: 'Learned ✓',
      canFinish: false,
      hasHeart: false,
    });
  });

  it("reads Learn again, and can be pressed, when the run didn't finish", () => {
    expect(doneState({ ...ready, learn: unstarted })).toEqual({
      label: 'Learn again',
      canFinish: true,
      hasHeart: true,
    });
  });

  it("can be pressed when the learn state can't be read, leaving the server to decide", () => {
    expect(doneState({ ...ready, learn: undefined, isLearnUnreadable: true })).toEqual({
      label: 'Done',
      canFinish: true,
      hasHeart: true,
    });
  });

  it('reads Sending… and is disabled while Done is being sent', () => {
    expect(doneState({ ...ready, isSending: true })).toMatchObject({
      label: 'Sending…',
      canFinish: false,
    });
  });
});

describe('learnLine', () => {
  it('says the page asked again while that ask learns', () => {
    expect(learnLine({ ...learning, isRetry: true })).toMatch(/^GitLab didn't pick that up/);
  });

  it('says why a learn did not finish', () => {
    expect(learnLine(unstarted)).toMatch(/^GitLab never picked up your Done/);
    expect(learnLine({ ...unstarted, isRetry: true })).toMatch(/even when we asked twice/);
    expect(learnLine({ ...unstarted, reason: 'Stalled' })).toMatch(/went quiet/);
    expect(learnLine({ ...unstarted, reason: 'Failed' })).toMatch(/its reply on the merge request/);
  });

  it('leaves swipes no Done asked for to the page', () => {
    expect(learnLine({ _tag: 'NotLearned' })).toBeNull();
  });
});

describe('askToRepeat', () => {
  const watched = new Set([ASK]);

  it('asks again for an ask GitLab never started, that the page watched', () => {
    expect(askToRepeat({ learn: unstarted, watched })).toBe(ASK);
    expect(askToRepeat({ learn: unstarted, watched: new Set() })).toBeUndefined();
  });

  it('never asks again for an ask asked again, one that started, or one still waiting', () => {
    expect(askToRepeat({ learn: { ...unstarted, isRetry: true }, watched })).toBeUndefined();
    expect(askToRepeat({ learn: { ...unstarted, reason: 'Stalled' }, watched })).toBeUndefined();
    expect(askToRepeat({ learn: learning, watched })).toBeUndefined();
  });
});
