import { describe, expect, it } from '@effect/vitest';
import * as Effect from 'effect/Effect';
import { asRecord, auth, claimedRoundBody, json, withHandler } from './test-app';
import { FLOW_OTHER_TOKEN, FLOW_TOKEN, OAUTH_TOKEN, sampleRound } from './test-fixtures';

type Handler = (request: Request) => Promise<Response>;

const createRound = (handler: Handler) =>
  Effect.promise(async () =>
    handler(
      new Request('http://localhost/api/rounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(FLOW_TOKEN) },
        body: await claimedRoundBody(handler, FLOW_TOKEN, sampleRound),
      }),
    ).then(json),
  );

const getQuestions = (handler: Handler, projectId: string, token: string) =>
  Effect.promise(() =>
    handler(
      new Request(`http://localhost/api/projects/${projectId}/questions`, {
        headers: auth(token),
      }),
    ).then(json),
  );

describe('ProjectsApi', () => {
  it.effect('answers a project its questions, as its own flow', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const created = yield* createRound(handler);
        yield* Effect.promise(() =>
          handler(
            new Request(`http://localhost/api/rounds/${asRecord(created.body).id}/swipes`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json', ...auth(OAUTH_TOKEN) },
              body: JSON.stringify({ verdicts: { c1: 'like', c2: 'dislike', c3: 'like' } }),
            }),
          ),
        );

        const response = yield* getQuestions(handler, '111', FLOW_TOKEN);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          questions: [
            {
              id: 'early-returns',
              statement: 'Return early instead of nesting conditionals.',
              supports: { likes: 1, dislikes: 0 },
              opposes: { likes: 0, dislikes: 0 },
              roundsSinceJudged: 0,
            },
            {
              id: 'named-results',
              statement: 'Name an intermediate result instead of returning an expression inline.',
              supports: { likes: 1, dislikes: 0 },
              opposes: { likes: 0, dislikes: 1 },
              roundsSinceJudged: 0,
            },
          ],
        });
      }),
    ),
  );

  it.effect('answers no questions for a project with no rounds', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        const response = yield* getQuestions(handler, '222', FLOW_OTHER_TOKEN);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ questions: [] });
      }),
    ),
  );

  it.effect('forbids a developer, even one who can read the project', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* createRound(handler);
        const response = yield* getQuestions(handler, '111', OAUTH_TOKEN);
        expect(response.status).toBe(403);
        expect(asRecord(response.body)._tag).toBe('Forbidden');
      }),
    ),
  );

  it.effect('forbids a flow of another project', () =>
    withHandler(handler =>
      Effect.gen(function* () {
        yield* createRound(handler);
        const response = yield* getQuestions(handler, '111', FLOW_OTHER_TOKEN);
        expect(response.status).toBe(403);
        expect(asRecord(response.body)._tag).toBe('Forbidden');
      }),
    ),
  );
});
