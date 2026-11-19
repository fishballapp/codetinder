import * as OpenApi from 'effect/http-api/OpenApi';
import { describe, expect, it } from 'vitest';
import { WaitlistApi } from './waitlist';
import { WAITLIST_PATH } from './waitlist-form';

describe('the waitlist API document', () => {
  const operation = OpenApi.fromApi(WaitlistApi).paths[WAITLIST_PATH]?.post;

  it('has one POST at the path the form uses', () => {
    expect(operation?.operationId).toBe('waitlist.join');
  });

  it('answers 200, 400, 413 and 429 and nothing else', () => {
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual(['200', '400', '413', '429']);
  });
});
