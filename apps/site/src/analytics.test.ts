import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  trackDemoFinished,
  trackDemoSwiped,
  trackWaitlistCtaClick,
  trackWaitlistFailed,
  trackWaitlistInvalid,
  trackWaitlistJoined,
  trackWaitlistSubmitted,
} from './analytics';

const posthog = { capture: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.window = { posthog } as unknown as Window & typeof globalThis;
});

describe('the waitlist events', () => {
  it('names where a link to the signup card sits', () => {
    trackWaitlistCtaClick('nav');

    expect(posthog.capture).toHaveBeenCalledExactlyOnceWith(
      'waitlist_cta_clicked',
      { placement: 'nav' },
      { send_instantly: true },
    );
  });

  it('ignores a link whose placement is not one the site declares', () => {
    trackWaitlistCtaClick('someone@example.com');
    trackWaitlistCtaClick(undefined);

    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('says `none` for a platform the visitor left out', () => {
    trackWaitlistSubmitted(undefined);
    trackWaitlistJoined('gitlab');

    expect(posthog.capture).toHaveBeenNthCalledWith(
      1,
      'waitlist_submitted',
      { platform: 'none' },
      undefined,
    );
    expect(posthog.capture).toHaveBeenNthCalledWith(
      2,
      'waitlist_joined',
      { platform: 'gitlab' },
      undefined,
    );
  });

  it('sends why a join failed, and nothing about who joined', () => {
    trackWaitlistFailed('rate_limited');
    trackWaitlistInvalid();

    expect(posthog.capture).toHaveBeenNthCalledWith(
      1,
      'waitlist_failed',
      { reason: 'rate_limited' },
      undefined,
    );
    expect(posthog.capture).toHaveBeenNthCalledWith(2, 'waitlist_invalid', undefined, undefined);
  });

  it('takes no free-form text, so an address cannot be sent', () => {
    // @ts-expect-error a platform is one of the form's choices, not a string
    trackWaitlistSubmitted('someone@example.com');
    // @ts-expect-error a failure is one of the form's three reasons, not a string
    trackWaitlistFailed('someone@example.com');
  });
});

describe('the demo events', () => {
  it('calls a dislike a nope', () => {
    trackDemoSwiped('like');
    trackDemoSwiped('dislike');

    expect(posthog.capture).toHaveBeenNthCalledWith(
      1,
      'demo_swiped',
      { verdict: 'like' },
      undefined,
    );
    expect(posthog.capture).toHaveBeenNthCalledWith(
      2,
      'demo_swiped',
      { verdict: 'nope' },
      undefined,
    );
  });

  it('marks the last card with no properties', () => {
    trackDemoFinished();

    expect(posthog.capture).toHaveBeenCalledExactlyOnceWith('demo_finished', undefined, undefined);
  });
});
