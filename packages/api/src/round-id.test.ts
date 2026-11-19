import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { describe, expect, it } from 'vitest';
import { makeRoundId, ROUND_ID_LENGTH, RoundIdSchema } from './round-id';

describe('RoundIdSchema', () => {
  const decode = Schema.decodeUnknownResult(RoundIdSchema);

  it('accepts 12 base62 characters', () => {
    expect(decode('0123456789AB')).toEqual(Result.succeed('0123456789AB'));
    expect(Result.isSuccess(decode('abcdefghijkl'))).toBe(true);
    expect(Result.isSuccess(decode('Zz9yXwVuTsRq'))).toBe(true);
  });

  it('rejects the wrong length or alphabet', () => {
    expect(Result.isFailure(decode('short'))).toBe(true);
    expect(Result.isFailure(decode('0123456789ABC'))).toBe(true);
    expect(Result.isFailure(decode('0123456789A_'))).toBe(true);
  });
});

describe('makeRoundId', () => {
  it('maps each byte onto base62 and brands the result', () => {
    const bytes = Uint8Array.from({ length: ROUND_ID_LENGTH }, (_, i) => i);
    expect(makeRoundId(bytes)).toBe('0123456789AB');
  });

  it('uses only the first 12 bytes', () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => (i + 10) % 62);
    expect(makeRoundId(bytes)).toHaveLength(ROUND_ID_LENGTH);
  });

  it('throws when given too few bytes', () => {
    expect(() => makeRoundId(new Uint8Array(3))).toThrow(/12 random bytes/);
  });
});
