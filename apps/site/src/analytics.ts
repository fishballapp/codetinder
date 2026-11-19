import type { Platform } from '@codetinder/api/waitlist-form';
import type { Verdict } from '@codetinder/core';
import { capture } from '@internal/marketing/posthog';

/**
 * Every event the site sends to PostHog, and every property on it. A property is a value from a
 * closed list, never a string typed or read from the page: the visitor's email address never
 * reaches PostHog, in an event, an identify or a person property, and a new property must stay in
 * that shape. `capture()` is a no-op where the PostHog snippet isn't on the page (localhost).
 */

/** The links that jump to the signup card, by where they sit. */
export const WAITLIST_PLACEMENTS = ['nav', 'closing', 'not_found', 'demo_finale'] as const;
export type WaitlistPlacement = (typeof WAITLIST_PLACEMENTS)[number];

/** Why a join failed, as the form tells the visitor. */
export type WaitlistFailure = 'rate_limited' | 'refused' | 'unreachable';

const isWaitlistPlacement = (value: string | undefined): value is WaitlistPlacement =>
  WAITLIST_PLACEMENTS.some(placement => placement === value);

/** The platform a visitor named, or `none` when they left it out. */
const platformProperty = (platform: Platform | undefined): Platform | 'none' => platform ?? 'none';

/** A click on a link to the signup card; `placement` is the link's `data-waitlist-cta`. */
export const trackWaitlistCtaClick = (placement: string | undefined): void => {
  if (!isWaitlistPlacement(placement)) return;
  // Sent at once: a click on a link to the landing page leaves the page it was made on.
  capture('waitlist_cta_clicked', { placement }, { send_instantly: true });
};

/** The form sent a valid address. */
export const trackWaitlistSubmitted = (platform: Platform | undefined): void =>
  capture('waitlist_submitted', { platform: platformProperty(platform) });

/** The waitlist took the address. */
export const trackWaitlistJoined = (platform: Platform | undefined): void =>
  capture('waitlist_joined', { platform: platformProperty(platform) });

/** The waitlist refused or couldn't be reached. */
export const trackWaitlistFailed = (reason: WaitlistFailure): void =>
  capture('waitlist_failed', { reason });

/** The form was submitted with an address it refuses on the page, before anything was sent. */
export const trackWaitlistInvalid = (): void => capture('waitlist_invalid');

/** A swipe in the demo, in the words of the buttons: `nope` for a dislike. */
export const trackDemoSwiped = (verdict: Verdict): void =>
  capture('demo_swiped', { verdict: verdict === 'like' ? 'like' : 'nope' });

/** The demo's last card, the match card, is showing. */
export const trackDemoFinished = (): void => capture('demo_finished');
