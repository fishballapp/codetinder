import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import * as TestClock from 'effect/testing/TestClock';
import {
  GITLAB_BASE_URL,
  gitLabClient,
  gitLabInteractiveClient,
  paginateGitLab,
  repeatable,
} from './gitlab';

const withFetch = (fetch: typeof globalThis.fetch) =>
  Layer.succeed(FetchHttpClient.Fetch, fetch).pipe(Layer.provideMerge(FetchHttpClient.layer));

/** A fetch that answers each attempt as `answer` says, counting them. */
const scriptedFetch = (answer: (attempt: number) => Promise<Response> | Response) => {
  const counter = { attempts: 0 };
  const fetch: typeof globalThis.fetch = async () => {
    counter.attempts += 1;
    return answer(counter.attempts);
  };
  return { fetch, counter };
};

const neverAnswers = () => new Promise<Response>(() => {});

const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const http = gitLabInteractiveClient(yield* HttpClient.HttpClient);
    return yield* http.execute(request);
  });

/** Lets every attempt time out and every backoff pass. */
const passAllAttempts = Effect.forEach(
  Array.from({ length: 6 }),
  () => TestClock.adjust('10 seconds').pipe(Effect.andThen(Effect.yieldNow)),
  { discard: true },
);

describe('gitLabInteractiveClient', () => {
  it.effect('sends the request to GitLab', () => {
    const { fetch } = scriptedFetch(() => new Response('{}', { status: 200 }));
    return Effect.gen(function* () {
      const response = yield* send(HttpClientRequest.get('/api/v4/user'));
      expect(response.request.url).toBe(`${GITLAB_BASE_URL}/api/v4/user`);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect.each(['GET', 'HEAD', 'PUT', 'DELETE'] as const)(
    'retries a transient failure of a %s, which is safe to repeat',
    method => {
      const { fetch, counter } = scriptedFetch(attempt =>
        attempt < 3 ? new Response('', { status: 503 }) : new Response('', { status: 200 }),
      );
      return Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(send(HttpClientRequest.make(method)('/api/v4/x')));
        yield* passAllAttempts;
        const response = yield* Fiber.join(fiber);
        expect(response.status).toBe(200);
        expect(counter.attempts).toBe(3);
      }).pipe(Effect.provide(withFetch(fetch)));
    },
  );

  it.effect('retries an attempt GitLab is slow to answer', () => {
    const { fetch, counter } = scriptedFetch(attempt =>
      attempt === 1 ? neverAnswers() : new Response('', { status: 200 }),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(send(HttpClientRequest.get('/api/v4/x')));
      yield* passAllAttempts;
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(200);
      expect(counter.attempts).toBe(2);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('dies when no attempt is answered, within 26 seconds', () => {
    const { fetch, counter } = scriptedFetch(neverAnswers);
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(send(HttpClientRequest.get('/api/v4/x'))));
      yield* TestClock.adjust('26 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
      expect(counter.attempts).toBe(3);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('answers the last transient status once the retries are spent', () => {
    const { fetch, counter } = scriptedFetch(() => new Response('', { status: 502 }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(send(HttpClientRequest.get('/api/v4/x')));
      yield* passAllAttempts;
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(502);
      expect(counter.attempts).toBe(3);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('sends a POST once, answering a transient status as it is', () => {
    const { fetch, counter } = scriptedFetch(() => new Response('', { status: 503 }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(send(HttpClientRequest.post('/api/v4/x')));
      yield* passAllAttempts;
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(503);
      expect(counter.attempts).toBe(1);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('gives a POST one attempt of 8 seconds, then dies', () => {
    const { fetch, counter } = scriptedFetch(neverAnswers);
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(send(HttpClientRequest.post('/api/v4/x'))));
      yield* TestClock.adjust('8 seconds');
      const exit = yield* Fiber.join(fiber);
      expect(Exit.hasDies(exit)).toBe(true);
      expect(counter.attempts).toBe(1);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('retries a POST marked repeatable', () => {
    const { fetch, counter } = scriptedFetch(attempt =>
      attempt === 1 ? new Response('', { status: 503 }) : new Response('', { status: 200 }),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        send(HttpClientRequest.post('/api/graphql')).pipe(repeatable),
      );
      yield* passAllAttempts;
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(200);
      expect(counter.attempts).toBe(2);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('spends one retry budget on statuses and timeouts together', () => {
    const { fetch, counter } = scriptedFetch(attempt =>
      attempt <= 2 ? new Response('', { status: 503 }) : neverAnswers(),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(send(HttpClientRequest.get('/api/v4/x'))));
      yield* passAllAttempts;
      expect(Exit.hasDies(yield* Fiber.join(fiber))).toBe(true);
      expect(counter.attempts).toBe(3);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('answers the last status when a timeout came first, within the same budget', () => {
    const { fetch, counter } = scriptedFetch(attempt =>
      attempt === 1 ? neverAnswers() : new Response('', { status: 503 }),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(send(HttpClientRequest.get('/api/v4/x')));
      yield* passAllAttempts;
      expect((yield* Fiber.join(fiber)).status).toBe(503);
      expect(counter.attempts).toBe(3);
    }).pipe(Effect.provide(withFetch(fetch)));
  });
});

describe('gitLabClient', () => {
  const sendAsFlow = (request: HttpClientRequest.HttpClientRequest) =>
    Effect.gen(function* () {
      const http = gitLabClient(
        yield* HttpClient.HttpClient,
        GITLAB_BASE_URL,
        Redacted.make('run-token'),
      );
      return yield* http.execute(request);
    });

  const passAllFlowAttempts = Effect.forEach(
    Array.from({ length: 8 }),
    () => TestClock.adjust('30 seconds').pipe(Effect.andThen(Effect.yieldNow)),
    { discard: true },
  );

  it.effect('spends one retry budget on statuses and timeouts together: four attempts', () => {
    const { fetch, counter } = scriptedFetch(attempt =>
      attempt % 2 === 1 ? new Response('', { status: 503 }) : neverAnswers(),
    );
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.exit(sendAsFlow(HttpClientRequest.get('/api/v4/x'))),
      );
      yield* passAllFlowAttempts;
      expect(Exit.hasDies(yield* Fiber.join(fiber))).toBe(true);
      expect(counter.attempts).toBe(4);
    }).pipe(Effect.provide(withFetch(fetch)));
  });

  it.effect('answers the last transient status once the retries are spent', () => {
    const { fetch, counter } = scriptedFetch(() => new Response('', { status: 500 }));
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendAsFlow(HttpClientRequest.get('/api/v4/x')));
      yield* passAllFlowAttempts;
      expect((yield* Fiber.join(fiber)).status).toBe(500);
      expect(counter.attempts).toBe(4);
    }).pipe(Effect.provide(withFetch(fetch)));
  });
});

describe('paginateGitLab', () => {
  /** A page of `items` whose response names `nextPage` the way GitLab does. */
  const pageOf = (items: readonly string[], nextPage: string | undefined) => ({
    items,
    response: HttpClientResponse.fromWeb(
      HttpClientRequest.get('/api/v4/x'),
      new Response('[]', { headers: nextPage === undefined ? {} : { 'x-next-page': nextPage } }),
    ),
  });

  it.effect('follows the next page until GitLab names none, keeping page order', () => {
    const requestedPages: number[] = [];
    const pages: Record<number, ReturnType<typeof pageOf>> = {
      1: pageOf(['a', 'b'], '2'),
      2: pageOf(['c'], '3'),
      3: pageOf(['d'], ''),
    };
    return Effect.gen(function* () {
      const items = yield* paginateGitLab(page => {
        requestedPages.push(page);
        return Effect.succeed(pages[page] ?? pageOf([], undefined));
      });
      expect(items).toEqual(['a', 'b', 'c', 'd']);
      expect(requestedPages).toEqual([1, 2, 3]);
    });
  });

  it.effect('stops after the first page when it has no next-page header', () => {
    const requestedPages: number[] = [];
    return Effect.gen(function* () {
      const items = yield* paginateGitLab(page => {
        requestedPages.push(page);
        return Effect.succeed(pageOf(['only'], undefined));
      });
      expect(items).toEqual(['only']);
      expect(requestedPages).toEqual([1]);
    });
  });

  it.effect('fails with the failing page', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        paginateGitLab(page =>
          page === 1 ? Effect.succeed(pageOf(['a'], '2')) : Effect.fail('page 2 failed'),
        ),
      );
      expect(error).toBe('page 2 failed');
    }),
  );
});
