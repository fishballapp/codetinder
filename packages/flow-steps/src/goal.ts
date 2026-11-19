import { RoundIdSchema } from '@codetinder/api';
import { parseGoal } from '@codetinder/core';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { userError } from './user-error';

/** The run's route, read from the trigger's goal and what the run's context says fired it. */
export const readRoute = Effect.fn('goal.readRoute')(function* () {
  const goal = yield* Config.NonEmptyString('DUO_WORKFLOW_GOAL');
  const context = yield* Config.option(Config.String('DUO_WORKFLOW_ADDITIONAL_CONTEXT_CONTENT'));
  return yield* Effect.fromResult(
    parseGoal({ goal, context: Option.getOrUndefined(context) }),
  ).pipe(Effect.mapError(userError));
});

/** The merge request the run is on: a round's, or the one a learn mention is in. */
export const readMergeRequestIid = Effect.fn('goal.readMergeRequestIid')(function* () {
  const route = yield* readRoute();
  if (route._tag === 'nomergerequest') {
    return yield* userError({ message: 'the run is on no merge request' });
  }
  return route.mergeRequestIid;
});

/** The MR and event of a round's run. */
export const readGenerateRoute = Effect.fn('goal.readGenerateRoute')(function* () {
  const route = yield* readRoute();
  if (route._tag !== 'generate') {
    return yield* userError({ message: 'expected a run that starts a round on a merge request' });
  }
  return route;
});

/** The MR and round of a learn run. */
export const readLearnRoute = Effect.fn('goal.readLearnRoute')(function* () {
  const route = yield* readRoute();
  if (route._tag !== 'learn') {
    return yield* userError({ message: 'expected a learn mention naming a round' });
  }
  const roundId = yield* Schema.decodeEffect(RoundIdSchema)(route.roundId).pipe(
    Effect.mapError(error => userError(error, `"${route.roundId}" is not a round id`)),
  );
  return { mergeRequestIid: route.mergeRequestIid, roundId };
});
