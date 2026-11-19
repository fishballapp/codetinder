import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as Layer from 'effect/Layer';
import { ApiRoutes } from './app';
import { RoundStore } from './round-store';
import { SweepStore } from './sweep-store';
import { fakeIdTokens, fakeUsers } from './test-fixtures';

/** The API over the in-memory stores and the fake GitLab. */
export const TestApp = ApiRoutes.pipe(
  Layer.provide(Layer.mergeAll(RoundStore.memory, SweepStore.memory)),
  Layer.provide(fakeIdTokens),
  Layer.provide(fakeUsers),
  Layer.provide(HttpServer.layerServices),
);

export const withHandler = <A, E>(
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(TestApp, { disableLogger: true })),
    ({ handler }) => use(handler),
    ({ dispose }) => Effect.promise(dispose),
  );

export type JsonBody = { readonly status: number; readonly body: unknown };

export const json = async (response: Response): Promise<JsonBody> => ({
  status: response.status,
  body: response.headers.get('content-type')?.includes('json')
    ? await response.json()
    : await response.text(),
});

export const asRecord = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== 'object') {
    throw new Error(`expected object body, got ${typeof body}`);
  }
  return body as Record<string, unknown>;
};

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Claims a fresh commit of MR 7 as `token`'s flow and answers the body of the round upload that
 * claim allows: each call is its own run on its own commit, so each stores its own round.
 */
export const claimedRoundBody = async (
  handler: (request: Request) => Promise<Response>,
  token: string,
  round: unknown,
): Promise<string> => {
  const headSha = Array.from(crypto.getRandomValues(new Uint8Array(20)), byte =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const runId = crypto.randomUUID();
  const claim = { mergeRequestIid: 7, headSha, runId, event: 'merge_request' };
  await handler(
    new Request('http://localhost/api/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(token) },
      body: JSON.stringify(claim),
    }),
  );
  return JSON.stringify({ mergeRequestIid: 7, headSha, runId, round });
};
