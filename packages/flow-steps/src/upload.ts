import type { EnvironmentFailure, Round } from '@codetinder/core';
import * as Effect from 'effect/Effect';
import type { RunClaim } from './claim';
import { CodeTinder, readServiceAccount, roundUrl } from './codetinder';

export type RoundOutcome =
  | {
      readonly _tag: 'Uploaded';
      readonly round: Round;
      readonly url: string;
      /** The flow's service account, which the round's note tells the developer to mention. */
      readonly serviceAccount: string;
      /** How many of the round's cards ask a question outside the project's latest judged rounds. */
      readonly eligibleCards?: number;
    }
  | {
      readonly _tag: 'Skipped';
      readonly reason: string;
      readonly environment?: EnvironmentFailure;
    };

export const skipped = (reason: string): RoundOutcome => ({ _tag: 'Skipped', reason });

export const uploadRound = Effect.fn('round.upload')(function* ({
  mergeRequestIid,
  claim,
  round,
  eligibleCards,
}: {
  readonly mergeRequestIid: number;
  /** The run's claim on the commit: its round is stored once, however often it is sent. */
  readonly claim: RunClaim;
  readonly round: Round;
  readonly eligibleCards?: number;
}) {
  const codetinder = yield* CodeTinder;
  // Read first: a round is stored only when its note can be written.
  const serviceAccount = yield* readServiceAccount();
  const refused = (error: { readonly message: string }) =>
    Effect.succeed(skipped(`codetinder.dev refused the round: ${error.message}`));

  return yield* codetinder
    .createRound({ mergeRequestIid, headSha: claim.headSha, runId: claim.runId, round })
    .pipe(
      Effect.map(
        ({ id }): RoundOutcome => ({
          _tag: 'Uploaded',
          round,
          url: roundUrl(codetinder.baseUrl, id),
          serviceAccount,
          eligibleCards,
        }),
      ),
      Effect.catchTags({
        RoundTooLarge: refused,
        NotClaimOwner: refused,
        Forbidden: refused,
        Unauthorized: refused,
      }),
    );
});
