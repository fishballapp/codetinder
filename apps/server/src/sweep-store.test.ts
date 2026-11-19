import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { type SweepRecord, SweepStore } from './sweep-store';

const sweep = (threshold: number): SweepRecord => ({
  threshold,
  last: null,
  stopped: null,
  carryOver: [],
  claim: null,
});

describe('SweepStore.memory', () => {
  it.effect('reads no sweep before one is written', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      expect(yield* store.get('111')).toEqual(Option.none());
    }).pipe(Effect.provide(SweepStore.memory)),
  );

  it.effect('creates a sweep only while the project has none', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      const create = () =>
        store.write({ projectId: '111', sweep: sweep(300), expectedRevision: Option.none() });
      expect(yield* create()).toBe(true);
      expect(yield* create()).toBe(false);
      expect(Option.getOrThrow(yield* store.get('111')).sweep).toEqual(sweep(300));
    }).pipe(Effect.provide(SweepStore.memory)),
  );

  it.effect('writes over a sweep only at the revision it was read at', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      yield* store.write({ projectId: '111', sweep: sweep(300), expectedRevision: Option.none() });
      const read = Option.getOrThrow(yield* store.get('111'));

      const stale = yield* store.write({
        projectId: '111',
        sweep: sweep(400),
        expectedRevision: Option.some('not-the-revision'),
      });
      expect(stale).toBe(false);

      const written = yield* store.write({
        projectId: '111',
        sweep: sweep(400),
        expectedRevision: Option.some(read.revision),
      });
      expect(written).toBe(true);
      const after = Option.getOrThrow(yield* store.get('111'));
      expect(after.sweep.threshold).toBe(400);
      expect(after.revision).not.toBe(read.revision);
    }).pipe(Effect.provide(SweepStore.memory)),
  );

  it.effect('keeps each project sweep sweep apart', () =>
    Effect.gen(function* () {
      const store = yield* SweepStore;
      yield* store.write({ projectId: '111', sweep: sweep(300), expectedRevision: Option.none() });
      expect(yield* store.get('222')).toEqual(Option.none());
    }).pipe(Effect.provide(SweepStore.memory)),
  );
});
