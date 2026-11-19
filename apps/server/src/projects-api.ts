import { Api, CurrentCaller, Forbidden, QUESTION_ROUNDS } from '@codetinder/api';
import { questionsOf } from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder';
import { RoundStore } from './round-store';

export const ProjectsApiLive = HttpApiBuilder.group(
  Api,
  'projects',
  Effect.fn('ProjectsApiLive')(function* (handlers) {
    const store = yield* RoundStore;

    return handlers.handleAll({
      getQuestions: Effect.fn('ProjectsApi.getQuestions')(function* ({ params }) {
        const caller = yield* CurrentCaller;
        if (caller._tag !== 'Flow' || caller.projectId !== params.projectId) {
          return yield* new Forbidden({
            message: 'only a flow of this project may read its questions',
          });
        }

        const rounds = yield* store.listRounds(params.projectId, QUESTION_ROUNDS);
        const swipes = yield* store.listSwipes(rounds.map(({ id }) => id));
        return {
          questions: questionsOf(
            rounds.map(({ id, round }) => ({ round, swipes: swipes.get(id) ?? [] })),
          ),
        };
      }),
    });
  }),
);
