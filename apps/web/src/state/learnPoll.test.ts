import { AskIdSchema, type LearnState } from '@codetinder/api';
import * as Exit from 'effect/Exit';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { shouldPollLearn } from './learnPoll';

const askId = Schema.decodeSync(AskIdSchema)('7c9e6679-7425-40de-944b-e07fc1f90ae7');
const unfinished: LearnState = {
  _tag: 'Unfinished',
  askId,
  isRetry: false,
  reason: 'NotStarted',
  isSettled: false,
};
const polls = (learn: LearnState) => shouldPollLearn(Exit.succeed(learn));

describe('shouldPollLearn', () => {
  it('keeps reading after a read that failed', () => {
    expect(shouldPollLearn(Exit.fail('503'))).toBe(true);
    expect(shouldPollLearn(Exit.die(new Error('network')))).toBe(true);
  });

  it('keeps reading while a run learns, or one that did not finish may still report', () => {
    expect(polls({ _tag: 'Learning', askId, isRetry: false })).toBe(true);
    expect(polls(unfinished)).toBe(true);
  });

  it('stops once nothing can change the state but a new swipe or Done', () => {
    expect(polls({ _tag: 'Learned' })).toBe(false);
    expect(polls({ _tag: 'NotLearned' })).toBe(false);
    expect(polls({ ...unfinished, isSettled: true })).toBe(false);
  });
});
