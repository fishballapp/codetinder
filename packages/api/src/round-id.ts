import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

export const ROUND_ID_LENGTH = 12;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export const RoundIdSchema = Schema.String.pipe(
  Schema.check(
    Schema.isBetweenLength(ROUND_ID_LENGTH, ROUND_ID_LENGTH),
    Schema.isPattern(/^[0-9A-Za-z]+$/),
  ),
  Schema.brand('RoundId'),
);
export type RoundId = typeof RoundIdSchema.Type;

/** Map `randomBytes` (at least 12 long) onto a RoundId; the server supplies the randomness. */
export const makeRoundId = (randomBytes: Uint8Array): RoundId => {
  if (randomBytes.length < ROUND_ID_LENGTH) {
    throw new Error(`makeRoundId needs ${ROUND_ID_LENGTH} random bytes`);
  }
  const id = Array.from(randomBytes.subarray(0, ROUND_ID_LENGTH), byte => {
    const char = BASE62[byte % BASE62.length];
    if (char === undefined) throw new Error('base62 alphabet is empty');
    return char;
  }).join('');
  return Result.getOrThrow(Schema.decodeResult(RoundIdSchema)(id));
};
