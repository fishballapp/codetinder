// What the waitlist form and the Worker agree on, as plain values with no imports: the
// site's form island reads this module and ships no Effect runtime.

export const WAITLIST_PATH = '/api/waitlist';

export const PLATFORMS = ['github', 'gitlab', 'both'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * The ids of the wording a visitor can be shown next to the form. A row keeps the id it joined
 * under. The text of each id is in the site (`apps/site`), one entry per id, never edited once a
 * visitor has joined under it: new wording is a new id here and a new entry there.
 */
export const CONSENT_VERSIONS = ['v1'] as const;
export type ConsentVersion = (typeof CONSENT_VERSIONS)[number];

/** RFC 5321's longest path, 256 characters, less its angle brackets. */
export const MAX_EMAIL_LENGTH = 254;

/**
 * An ASCII address: a dot-separated local part of up to 64 characters, and a domain of at least
 * two labels whose last is letters only, or a punycode label (`xn--p1ai`). Quoted local parts, IP-literal domains and non-ASCII
 * addresses are refused: none is an address a person types into a form, and ASCII keeps the
 * lower-casing that makes two spellings one address exact.
 */
export const EMAIL_PATTERN =
  /^(?=[^@]{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[Xx][Nn]--[A-Za-z0-9-]{1,57}[A-Za-z0-9]|[A-Za-z]{2,63})$/u;

/** A field the form hides from people. A bot that fills in every field fills in this one. */
export const HONEYPOT_FIELD = 'website';

/** The largest request body, in bytes. A real one is well under 300. */
export const MAX_BODY_BYTES = 1024;
