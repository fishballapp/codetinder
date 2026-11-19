import { makeRoundId } from '@codetinder/api';
import { describe, expect, it } from '@effect/vitest';
import * as ConfigProvider from 'effect/ConfigProvider';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as TestClock from 'effect/testing/TestClock';
import { CodeTinder } from './codetinder';
import { scriptedFetch, withScriptedFetch } from './scripted-fetch';

const ROUND_ID = makeRoundId(new Uint8Array(12).fill(1));

const withConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({ CODETINDER_ID_TOKEN: 'test-id-token' }),
);

const codetinderWith = (fetch: typeof globalThis.fetch) =>
  CodeTinder.layer.pipe(Layer.provide(withScriptedFetch(fetch)), Layer.provide(withConfig));

const swipesJson = (status: number) =>
  new Response(JSON.stringify({ swipes: [] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** The client waits 500 ms, 1 s and 2 s between its retries; step the test clock through them. */
const passBackoffs = Effect.forEach(
  Array.from({ length: 5 }),
  () => TestClock.adjust('1 second').pipe(Effect.andThen(Effect.yieldNow)),
  { discard: true },
);

describe('CodeTinder client', () => {
  it.effect('retries a transient status until it answers', () => {
    const attempts = { count: 0 };
    return Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      const fiber = yield* Effect.forkChild(codetinder.getSwipes(ROUND_ID));
      yield* passBackoffs;
      expect(yield* Fiber.join(fiber)).toEqual({ swipes: [] });
      expect(attempts.count).toBe(3);
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(() => {
            attempts.count += 1;
            return swipesJson(attempts.count < 3 ? 503 : 200);
          }),
        ),
      ),
    );
  });

  it.effect('retries a network error', () => {
    const attempts = { count: 0 };
    return Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      const fiber = yield* Effect.forkChild(codetinder.getSwipes(ROUND_ID));
      yield* passBackoffs;
      expect(yield* Fiber.join(fiber)).toEqual({ swipes: [] });
      expect(attempts.count).toBe(2);
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(() => {
            attempts.count += 1;
            if (attempts.count === 1) throw new TypeError('fetch failed');
            return swipesJson(200);
          }),
        ),
      ),
    );
  });

  it.effect('gives up after three retries, as a fault', () => {
    const attempts = { count: 0 };
    return Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      const fiber = yield* Effect.forkChild(Effect.exit(codetinder.getSwipes(ROUND_ID)));
      yield* passBackoffs;
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
      expect(attempts.count).toBe(4);
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(() => {
            attempts.count += 1;
            return swipesJson(503);
          }),
        ),
      ),
    );
  });

  it.effect("reads the project's questions with the flow's ID token", () => {
    const requests: Request[] = [];
    const questions = [
      {
        id: 'early-returns',
        statement: 'Return early.',
        supports: { likes: 2, dislikes: 1 },
        opposes: { likes: 0, dislikes: 1 },
        roundsSinceJudged: 4,
      },
    ];
    return Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      expect(yield* codetinder.getQuestions('87434709')).toEqual({ questions });
      const [request] = requests;
      expect(requests).toHaveLength(1);
      expect(request!.method).toBe('GET');
      expect(request!.url).toBe('https://codetinder.dev/api/projects/87434709/questions');
      expect(request!.headers.get('authorization')).toBe('Bearer test-id-token');
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(request => {
            requests.push(request);
            return new Response(JSON.stringify({ questions }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    );
  });

  it.effect('keeps a refusal of the questions typed', () =>
    Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      const error = yield* Effect.flip(codetinder.getQuestions('87434709'));
      expect(error._tag).toBe('Forbidden');
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(
            () =>
              new Response(JSON.stringify({ _tag: 'Forbidden', message: 'another project' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
              }),
          ),
        ),
      ),
    ),
  );

  it.effect('does not retry an answer that is not transient', () => {
    const attempts = { count: 0 };
    return Effect.gen(function* () {
      const codetinder = yield* CodeTinder;
      const error = yield* Effect.flip(codetinder.getSwipes(ROUND_ID));
      expect(error._tag).toBe('RoundNotFound');
      expect(attempts.count).toBe(1);
    }).pipe(
      Effect.provide(
        codetinderWith(
          scriptedFetch(() => {
            attempts.count += 1;
            return new Response(JSON.stringify({ _tag: 'RoundNotFound', message: 'gone' }), {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          }),
        ),
      ),
    );
  });
});
