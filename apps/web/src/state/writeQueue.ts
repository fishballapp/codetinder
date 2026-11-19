import * as Deferred from 'effect/Deferred';
import * as Effect from 'effect/Effect';

/** Runs a write once every write queued before it has finished, whether it succeeded or not. */
export type WriteQueue = <A, E, R>(write: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/**
 * A queue for writes that each rewrite one thing whole, such as a trigger: they run one at a time,
 * in the order they were queued, so each reads what the one before it wrote. The order is fixed
 * when a write is queued, not when the one before it ends.
 */
export const makeWriteQueue = (): WriteQueue => {
  let previousDone: Effect.Effect<void> = Effect.void;
  return write =>
    Effect.suspend(() => {
      const waitForPrevious = previousDone;
      const done = Deferred.makeUnsafe<void>();
      previousDone = Deferred.await(done);
      return waitForPrevious.pipe(
        Effect.andThen(write),
        Effect.ensuring(Deferred.succeed(done, undefined)),
      );
    });
};
