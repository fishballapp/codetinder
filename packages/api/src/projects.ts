import { QuestionSchema } from '@codetinder/core';
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint';
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup';
import * as Schema from 'effect/Schema';
import { Forbidden, Unauthorized } from './authentication';

/** How many of a project's latest rounds its questions are worked out from. */
export const QUESTION_ROUNDS = 50;

export const GetQuestionsSuccessSchema = Schema.Struct({
  questions: Schema.Array(QuestionSchema),
});
export type GetQuestionsSuccess = typeof GetQuestionsSuccessSchema.Type;

export class ProjectsApi extends HttpApiGroup.make('projects')
  .add(
    HttpApiEndpoint.get('getQuestions', '/:projectId/questions', {
      params: { projectId: Schema.String.check(Schema.isPattern(/^\d+$/)) },
      success: GetQuestionsSuccessSchema,
      error: [Unauthorized, Forbidden],
    }),
  )
  .prefix('/api/projects') {}
