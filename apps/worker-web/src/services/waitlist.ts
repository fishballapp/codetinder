// Owns `waitlist_entry`. One row per address, unique on the normalised address.
import type { ConsentVersion, Platform } from '@codetinder/api/waitlist-form';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as SqlClient from 'effect/sql/SqlClient';

/**
 * The key two spellings of one address share: trimmed and lower-cased, nothing more. Dots and
 * `+tags` can name different mailboxes, so they stay.
 */
export const normaliseEmail = (email: string) => email.trim().toLowerCase();

export class Waitlist extends Context.Service<
  Waitlist,
  {
    /**
     * Adds the address, or finds it already there. Says which of the two to nobody: a repeat keeps
     * its first row's join time and consent, and takes the platform if it names one.
     */
    readonly join: (entry: {
      readonly email: string;
      readonly platform: Platform | undefined;
      readonly consentVersion: ConsentVersion;
    }) => Effect.Effect<void>;
  }
>()('@codetinder/worker-web/services/Waitlist') {
  static readonly layer = Layer.effect(
    Waitlist,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Waitlist.of({
        join: Effect.fn('Waitlist.join')(function* ({ email, platform, consentVersion }) {
          const joinedAt = yield* Clock.currentTimeMillis;
          // A person who submits again most likely means their latest answer, so a platform
          // replaces the stored one; leaving it out keeps what is there.
          yield* sql`
            INSERT INTO waitlist_entry (email, email_normalised, platform, consent_version, joined_at)
            VALUES (${email}, ${normaliseEmail(email)}, ${platform ?? null}, ${consentVersion}, ${joinedAt})
            ON CONFLICT (email_normalised)
            DO UPDATE SET platform = COALESCE(excluded.platform, platform)
          `.pipe(Effect.orDie);
        }),
      });
    }),
  );
}
