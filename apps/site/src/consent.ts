import type { ConsentVersion } from '@codetinder/api/waitlist-form';

/**
 * The line shown beside the waitlist's button, per consent id. A row keeps the id it joined under,
 * so never edit a version's text once someone has joined under it: new wording is a new id (in
 * `CONSENT_VERSIONS`) and a new entry here.
 */
export const CONSENT_TEXT: Record<ConsentVersion, string> = {
  v1: 'By joining, you agree to one email when CodeTinder is ready, and nothing else.',
};

/** The wording the form shows and sends today. */
export const CURRENT_CONSENT: ConsentVersion = 'v1';
