import { describe, expect, it } from '@effect/vitest';
import type * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Ref from 'effect/Ref';
import * as TestClock from 'effect/testing/TestClock';
import { makeWriteQueue } from './writeQueue';

/** A read-modify-write that takes a while: it appends to what it read, so a race loses a write. */
const append = (log: Ref.Ref<readonly string[]>, entry: string, delay: Duration.Input) =>
  Effect.gen(function* () {
    const read = yield* Ref.get(log);
    yield* Effect.sleep(delay);
    yield* Ref.set(log, [...read, entry]);
  });

describe('makeWriteQueue', () => {
  it.effect('runs writes one at a time, each reading what the one before it wrote', () =>
    Effect.gen(function* () {
      const queue = makeWriteQueue();
      const log = yield* Ref.make<readonly string[]>([]);
      const first = yield* Effect.forkChild(queue(append(log, 'first', '2 seconds')));
      const second = yield* Effect.forkChild(queue(append(log, 'second', '1 second')));
      yield* TestClock.adjust('3 seconds');
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(yield* Ref.get(log)).toEqual(['first', 'second']);
    }),
  );

  it.effect('runs the next write after one that failed', () =>
    Effect.gen(function* () {
      const queue = makeWriteQueue();
      const log = yield* Ref.make<readonly string[]>([]);
      const failing = yield* Effect.forkChild(
        queue(Effect.sleep('1 second').pipe(Effect.andThen(Effect.fail('refused')))),
      );
      const next = yield* Effect.forkChild(queue(append(log, 'next', '1 second')));
      yield* TestClock.adjust('2 seconds');
      expect(yield* Effect.flip(Fiber.join(failing))).toBe('refused');
      yield* Fiber.join(next);
      expect(yield* Ref.get(log)).toEqual(['next']);
    }),
  );

  it.effect('keeps the order writes were queued in, not the order they could start', () =>
    Effect.gen(function* () {
      const queue = makeWriteQueue();
      const log = yield* Ref.make<readonly string[]>([]);
      const fibers = yield* Effect.forEach(['a', 'b', 'c'], entry =>
        Effect.forkChild(queue(append(log, entry, '1 second'))),
      );
      yield* TestClock.adjust('3 seconds');
      yield* Effect.forEach(fibers, Fiber.join);
      expect(yield* Ref.get(log)).toEqual(['a', 'b', 'c']);
    }),
  );
});
