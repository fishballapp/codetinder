import { GitLabUsers, InvalidToken } from '@codetinder/gitlab';
import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import * as HttpRouter from 'effect/http/HttpRouter';
import * as HttpServer from 'effect/http/HttpServer';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';
import { ApiRoutes } from './app';
import { REQUEST_MAX_BYTES } from './request-body-limit';
import { RoundStore } from './round-store';
import { ROUND_MAX_BYTES } from './rounds-api';
import { SweepStore } from './sweep-store';
import { asRecord, auth, claimedRoundBody, json, withHandler } from './test-app';
import {
  BAD_OAUTH,
  FLOW_OTHER_TOKEN,
  FLOW_TOKEN,
  fakeIdTokens,
  OAUTH_NO_ACCESS,
  OAUTH_TEAMMATE_TOKEN,
  OAUTH_TOKEN,
  sampleRound,
} from './test-fixtures';

type Handler = (request: Request) => Promise<Response>;

/** One request as a token holder, its JSON answer. */
const call = (handler: Handler, token: string, method: string, path: string, body?: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...auth(token),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    ).then(json),
  );

const createRound = (handler: Handler) =>
  Effect.promise(() => claimedRoundBody(handler, FLOW_TOKEN, sampleRound)).pipe(
    Effect.flatMap(body => call(handler, FLOW_TOKEN, 'POST', '/api/rounds', JSON.parse(body))),
    Effect.map(created => String(asRecord(created.body).id)),
  );

const swipe = (handler: Handler, token: string, id: string, verdicts: Record<string, string>) =>
  call(handler, token, 'PUT', `/api/rounds/${id}/swipes`, { verdicts });

const learnOf = (handler: Handler, id: string) =>
  call(handler, OAUTH_TOKEN, 'GET', `/api/rounds/${id}/learn`);

/** Presses Done as `token`'s developer: the ask's id. */
const askToLearn = (handler: Handler, token: string, id: string) =>
  call(handler, token, 'POST', `/api/rounds/${id}/done`).pipe(
    Effect.map(asked => {
      expect(asked.status).toBe(200);
      return String(asRecord(asked.body).askId);
    }),
  );

const tieNote = (handler: Handler, id: string, askId: string, noteId: number) =>
  call(handler, OAUTH_TOKEN, 'PUT', `/api/rounds/${id}/done/note`, { askId, noteId });

const report = (handler: Handler, token: string, id: string, noteId: number, event: string) =>
  call(handler, token, 'POST', `/api/rounds/${id}/learn`, { noteId, report: event });

/** Asks to learn the swipes as they are, and has the run, replying to `noteId`, finish. */
const learnFinished = (handler: Handler, id: string, noteId: number) =>
  Effect.gen(function* () {
    const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
    yield* tieNote(handler, id, askId, noteId);
    yield* report(handler, FLOW_TOKEN, id, noteId, 'Started');
    yield* report(handler, FLOW_TOKEN, id, noteId, 'Finished');
  });

describe('RoundsApi', () => {
  it.effect('creates a round as a flow', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        expect(created.status).toBe(200);
        expect(created.body).toEqual({ id: expect.stringMatching(/^[0-9A-Za-z]{12}$/) });

        const got = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
              headers: auth(FLOW_TOKEN),
            }),
          ).then(json),
        );
        expect(got.status).toBe(200);
        expect(asRecord(got.body).projectId).toBe('111');
        expect(asRecord(got.body).mergeRequestIid).toBe(7);
      }),
    ),
  );

  it.effect('lets a developer with read access get a round and swipes', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );

        const got = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
              headers: auth(OAUTH_TOKEN),
            }),
          ).then(json),
        );
        expect(got.status).toBe(200);

        const put = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: JSON.stringify({
                verdicts: { c1: 'like' },
              }),
            }),
          ).then(json),
        );
        expect(put.status).toBe(204);

        const swipes = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}/swipes`, {
              headers: auth(OAUTH_TOKEN),
            }),
          ).then(json),
        );
        expect(swipes.status).toBe(200);
        expect(asRecord(swipes.body).swipes).toEqual([
          expect.objectContaining({
            userId: 42,
            username: 'ada',
            verdicts: { c1: 'like' },
          }),
        ]);
      }),
    ),
  );

  it.effect("answers a developer's own verdicts, not a teammate's", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        yield* swipe(handler, OAUTH_TEAMMATE_TOKEN, id, { c1: 'dislike', c2: 'like' });

        const mine = yield* call(handler, OAUTH_TOKEN, 'GET', `/api/rounds/${id}/swipes/mine`);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual({ c1: 'like' });
      }),
    ),
  );

  it.effect('answers no verdicts to a developer who has not swiped', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TEAMMATE_TOKEN, id, { c1: 'like' });

        const mine = yield* call(handler, OAUTH_TOKEN, 'GET', `/api/rounds/${id}/swipes/mine`);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual({});
      }),
    ),
  );

  it.effect('refuses own verdicts to a flow and to a developer who cannot read the code', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);

        const asFlow = yield* call(handler, FLOW_TOKEN, 'GET', `/api/rounds/${id}/swipes/mine`);
        expect(asFlow.status).toBe(403);

        const asStranger = yield* call(
          handler,
          OAUTH_NO_ACCESS,
          'GET',
          `/api/rounds/${id}/swipes/mine`,
        );
        expect(asStranger.status).toBe(403);
      }),
    ),
  );

  it.effect('has no verdicts to answer for a round that does not exist', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const missing = yield* call(
          handler,
          OAUTH_TOKEN,
          'GET',
          '/api/rounds/0123456789AB/swipes/mine',
        );
        expect(missing.status).toBe(404);
      }),
    ),
  );

  it.effect('replaces earlier verdicts on swipe upsert', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        const id = String(asRecord(created.body).id);

        yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: JSON.stringify({
                verdicts: { c1: 'like' },
              }),
            }),
          ),
        );
        yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: JSON.stringify({
                verdicts: { c2: 'dislike' },
              }),
            }),
          ),
        );

        const swipes = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${id}/swipes`, {
              headers: auth(FLOW_TOKEN),
            }),
          ).then(json),
        );
        const listed = asRecord(swipes.body).swipes;
        expect(Array.isArray(listed)).toBe(true);
        if (!Array.isArray(listed)) return;
        expect(listed).toHaveLength(1);
        expect(asRecord(listed[0]).verdicts).toEqual({ c2: 'dislike' });
      }),
    ),
  );

  it.effect('forbids a developer creating a round', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: await claimedRoundBody(handler, OAUTH_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        expect(response.status).toBe(403);
        expect(asRecord(response.body)._tag).toBe('Forbidden');
      }),
    ),
  );

  it.effect('forbids a flow saving swipes', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: JSON.stringify({ verdicts: {} }),
            }),
          ).then(json),
        );
        expect(response.status).toBe(403);
      }),
    ),
  );

  it.effect('forbids a flow from another project', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
              headers: auth(FLOW_OTHER_TOKEN),
            }),
          ).then(json),
        );
        expect(response.status).toBe(403);
      }),
    ),
  );

  it.effect('forbids a developer without read access', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        const response = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
              headers: auth(OAUTH_NO_ACCESS),
            }),
          ).then(json),
        );
        expect(response.status).toBe(403);
      }),
    ),
  );

  it.effect('returns RoundNotFound for a missing round', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request('http://localhost/api/rounds/0123456789AB', {
              headers: auth(FLOW_TOKEN),
            }),
          ).then(json),
        );
        expect(response.status).toBe(404);
        expect(asRecord(response.body)._tag).toBe('RoundNotFound');
      }),
    ),
  );

  it.effect('returns RoundTooLarge when the encoded round is over 900 KB', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const huge = {
          ...sampleRound,
          reason: 'x'.repeat(ROUND_MAX_BYTES),
        };
        const response = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, huge),
            }),
          ).then(json),
        );
        expect(response.status).toBe(413);
        expect(asRecord(response.body)._tag).toBe('RoundTooLarge');
      }),
    ),
  );

  it.effect('returns Unauthorized with no token', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        expect(response.status).toBe(401);
        expect(asRecord(response.body)._tag).toBe('Unauthorized');
      }),
    ),
  );

  it.effect('returns Unauthorized with a bad token', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request('http://localhost/api/rounds/0123456789AB', {
              headers: auth(BAD_OAUTH),
            }),
          ).then(json),
        );
        expect(response.status).toBe(401);
        expect(asRecord(response.body)._tag).toBe('Unauthorized');
      }),
    ),
  );

  it.effect('caches whoAmI so GitLab is called once for two requests', () => {
    const whoAmICalls: string[] = [];
    const countingUsers = Layer.succeed(
      GitLabUsers,
      GitLabUsers.of({
        whoAmI: (token: Redacted.Redacted<string>) => {
          whoAmICalls.push('whoAmI');
          if (Redacted.value(token) !== OAUTH_TOKEN) {
            return Effect.fail(new InvalidToken({ message: 'bad' }));
          }
          return Effect.succeed({ userId: 42, username: 'ada' });
        },
        canReadCode: () => Effect.succeed(true),
        canPush: () => Effect.succeed(true),
      }),
    );

    const app = ApiRoutes.pipe(
      Layer.provide(Layer.mergeAll(RoundStore.memory, SweepStore.memory)),
      Layer.provide(fakeIdTokens),
      Layer.provide(countingUsers),
      Layer.provide(HttpServer.layerServices),
    );

    return Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { disableLogger: true })),
      ({ handler }) =>
        Effect.gen(function* () {
          const created = yield* Effect.promise(async () =>
            handler(
              new Request('http://localhost/api/rounds', {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
                body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
              }),
            ).then(json),
          );
          yield* Effect.promise(() =>
            handler(
              new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
                headers: auth(OAUTH_TOKEN),
              }),
            ),
          );
          yield* Effect.promise(() =>
            handler(
              new Request(`http://localhost/api/rounds/${asRecord(created.body).id}`, {
                headers: auth(OAUTH_TOKEN),
              }),
            ),
          );
          expect(whoAmICalls).toHaveLength(1);
        }),
      ({ dispose }) => Effect.promise(dispose),
    );
  });

  it.effect('refuses swipes that name a card the round does not have', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        const id = asRecord(created.body).id;

        const put = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: JSON.stringify({ verdicts: { c1: 'like', c9: 'dislike' } }),
            }),
          ).then(json),
        );
        expect(put.status).toBe(400);
        expect(asRecord(put.body)._tag).toBe('InvalidSwipes');

        const swipes = yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${id}/swipes`, {
              headers: auth(FLOW_TOKEN),
            }),
          ).then(json),
        );
        expect(asRecord(swipes.body).swipes).toEqual([]);
      }),
    ),
  );

  it.effect('answers 413 to a declared length over 1 MiB without reading the body', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(async () =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': String(REQUEST_MAX_BYTES + 1),
                ...auth(FLOW_TOKEN),
              },
              body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
            }),
          ).then(json),
        );
        expect(response.status).toBe(413);
      }),
    ),
  );

  it.effect('answers 413 to a body over 1 MiB before anything parses it', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* Effect.promise(() =>
          handler(
            new Request('http://localhost/api/rounds', {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
              body: JSON.stringify({
                mergeRequestIid: 7,
                round: sampleRound,
                padding: 'x'.repeat(REQUEST_MAX_BYTES),
              }),
            }),
          ).then(json),
        );
        expect(response.status).toBe(413);
      }),
    ),
  );

  it.effect('asks to learn once, ties the reply, and reads Learned once its run finishes', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'NotLearned' });

        const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
        expect((yield* learnOf(handler, id)).body).toEqual({
          _tag: 'Learning',
          askId,
          isRetry: false,
        });
        const again = yield* call(handler, OAUTH_TOKEN, 'POST', `/api/rounds/${id}/done`);
        expect(again.status).toBe(409);
        expect(asRecord(again.body)._tag).toBe('AlreadyLearning');

        yield* tieNote(handler, id, askId, 900);
        expect((yield* report(handler, FLOW_TOKEN, id, 900, 'Started')).status).toBe(204);
        yield* report(handler, FLOW_TOKEN, id, 900, 'Finished');
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'Learned' });

        const learned = yield* call(handler, OAUTH_TOKEN, 'POST', `/api/rounds/${id}/done`);
        expect(learned.status).toBe(409);
        expect(asRecord(learned.body)._tag).toBe('AlreadyLearned');
      }),
    ),
  );

  it.effect('offers to learn again when the run reports a failure', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
        yield* tieNote(handler, id, askId, 900);
        yield* report(handler, FLOW_TOKEN, id, 900, 'Failed');
        expect((yield* learnOf(handler, id)).body).toEqual({
          _tag: 'Unfinished',
          askId,
          isRetry: false,
          reason: 'Failed',
          isSettled: true,
        });

        const learnAgain = yield* askToLearn(handler, OAUTH_TOKEN, id);
        expect(learnAgain).not.toBe(askId);
      }),
    ),
  );

  it.effect("ignores a report from a run whose ask a newer one superseded, or no ask's", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const first = yield* askToLearn(handler, OAUTH_TOKEN, id);
        yield* tieNote(handler, id, first, 900);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'dislike' });
        const second = yield* askToLearn(handler, OAUTH_TOKEN, id);
        yield* tieNote(handler, id, second, 901);

        yield* report(handler, FLOW_TOKEN, id, 900, 'Finished');
        yield* report(handler, FLOW_TOKEN, id, 555, 'Failed');
        expect((yield* learnOf(handler, id)).body).toEqual({
          _tag: 'Learning',
          askId: second,
          isRetry: false,
        });
      }),
    ),
  );

  it.effect('ties an ask to its reply once, and only the latest ask', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
        yield* tieNote(handler, id, askId, 900);
        expect((yield* tieNote(handler, id, askId, 901)).status).toBe(204);

        yield* report(handler, FLOW_TOKEN, id, 901, 'Finished');
        expect(asRecord((yield* learnOf(handler, id)).body)._tag).toBe('Learning');
        yield* report(handler, FLOW_TOKEN, id, 900, 'Finished');
        expect(asRecord((yield* learnOf(handler, id)).body)._tag).toBe('Learned');
      }),
    ),
  );

  it.effect('learns a round again once a swipe changes', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        yield* learnFinished(handler, id, 900);

        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'dislike' });
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'NotLearned' });
        yield* askToLearn(handler, OAUTH_TOKEN, id);

        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'NotLearned' });
      }),
    ),
  );

  it.effect("a teammate's swipe makes a learned round new", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        yield* learnFinished(handler, id, 900);

        yield* swipe(handler, OAUTH_TEAMMATE_TOKEN, id, { c2: 'dislike' });
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'NotLearned' });
        yield* askToLearn(handler, OAUTH_TEAMMATE_TOKEN, id);
      }),
    ),
  );

  it.effect('a teammate who undid every swipe leaves a learned round learned', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        yield* learnFinished(handler, id, 900);

        yield* swipe(handler, OAUTH_TEAMMATE_TOKEN, id, {});
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'Learned' });
      }),
    ),
  );

  it.effect('reads the order cards were swiped in as no change', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like', c2: 'dislike' });
        yield* learnFinished(handler, id, 900);

        yield* swipe(handler, OAUTH_TOKEN, id, { c2: 'dislike', c1: 'like' });
        expect((yield* learnOf(handler, id)).body).toEqual({ _tag: 'Learned' });
      }),
    ),
  );

  it.effect('lets only one of two simultaneous Dones ask', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const [first, second] = yield* Effect.all(
          [
            call(handler, OAUTH_TOKEN, 'POST', `/api/rounds/${id}/done`),
            call(handler, OAUTH_TOKEN, 'POST', `/api/rounds/${id}/done`),
          ],
          { concurrency: 'unbounded' },
        );
        expect([first.status, second.status].toSorted()).toEqual([200, 409]);
      }),
    ),
  );

  it.effect('refuses to ask again for an ask GitLab may still start', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
        const retry = yield* call(handler, OAUTH_TOKEN, 'POST', `/api/rounds/${id}/done/retry`, {
          askId,
        });
        expect(retry.status).toBe(409);
        expect(asRecord(retry.body)._tag).toBe('RetryNotDue');
      }),
    ),
  );

  it.effect('forbids a flow asking to learn, and a developer reporting', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        const done = yield* call(handler, FLOW_TOKEN, 'POST', `/api/rounds/${id}/done`);
        expect(done.status).toBe(403);
        expect((yield* report(handler, OAUTH_TOKEN, id, 900, 'Started')).status).toBe(403);
      }),
    ),
  );

  it.effect("forbids another project's flow reporting on the round", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, id, { c1: 'like' });
        const askId = yield* askToLearn(handler, OAUTH_TOKEN, id);
        yield* tieNote(handler, id, askId, 900);
        const reported = yield* report(handler, FLOW_OTHER_TOKEN, id, 900, 'Finished');
        expect(reported.status).toBe(403);
        expect(asRecord((yield* learnOf(handler, id)).body)._tag).toBe('Learning');
      }),
    ),
  );
});

describe('GET /api/rounds/:id/evidence', () => {
  const evidenceOf = (handler: Handler, token: string, id: string) =>
    call(handler, token, 'GET', `/api/rounds/${id}/evidence`);

  it.live("answers what the project's earlier rounds say about the principles a round tests", () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const earlier = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, earlier, { c1: 'like', c2: 'like', c3: 'like' });
        // The handler keeps the server's own clock: the next round must be made after this one.
        yield* Effect.sleep('5 millis');
        const later = yield* createRound(handler);
        yield* swipe(handler, OAUTH_TOKEN, later, { c1: 'dislike' });

        const diffOf = (after: string) => `@@ -1,1 +1,1 @@\n-function f() {}\n+${after}`;
        const card = (cardId: string, after: string, operation: string, change: string) => ({
          ref: `${earlier}/${cardId}`,
          file: 'src/f.ts',
          operation,
          change,
          diff: diffOf(after),
          likes: 1,
          dislikes: 0,
        });
        const response = yield* evidenceOf(handler, FLOW_TOKEN, later);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          evidence: [
            {
              id: 'early-returns',
              for: 1,
              against: 0,
              confirming: card(
                'c1',
                'function f(x: number) { if (x === 0) return 0; return 1; }',
                'Replace Nested Conditional with Guard Clauses',
                'Returns early on the empty case.',
              ),
              contradicting: null,
            },
            {
              id: 'named-results',
              for: 1,
              against: 1,
              confirming: card(
                'c3',
                'function f() { const result = 1; return result; }',
                'Extract Variable',
                'Pulls the returned value into a named constant.',
              ),
              contradicting: card(
                'c2',
                'function f() { const total = 1; return total; }',
                'Rename Variable',
                'Renames the local to `total`.',
              ),
            },
          ],
        });
        // The later round's swipes say nothing about the earlier one.
        expect((yield* evidenceOf(handler, FLOW_TOKEN, earlier)).body).toEqual({ evidence: [] });
      }),
    ),
  );

  it.effect('forbids a flow of another project', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const id = yield* createRound(handler);
        expect((yield* evidenceOf(handler, FLOW_OTHER_TOKEN, id)).status).toBe(403);
      }),
    ),
  );
});
