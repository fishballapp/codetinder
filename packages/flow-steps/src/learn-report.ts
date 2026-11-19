import { type LearnReport, RoundIdSchema } from '@codetinder/api';
import { oneLine } from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as Schema from 'effect/Schema';
import { CodeTinder } from './codetinder';
import { messageOf } from './user-error';

/**
 * Tells codetinder.dev how the learn run is going, so the round's page follows it: the run names
 * the Done reply that started it, and only that ask's reports apply. Never fails the run: a report
 * that doesn't land leaves the page to its deadlines.
 */
export const reportLearn = Effect.fn('learnReport.report')(function* ({
  roundId,
  noteId,
  report,
}: {
  readonly roundId: string;
  readonly noteId: number;
  readonly report: LearnReport;
}) {
  // On stderr: stdout's last line is the step's verdict, which the flow's router reads.
  const unreported = (failure: unknown) =>
    Console.error(`couldn't report the learn run ${report}: ${oneLine(messageOf(failure))}`);
  yield* Effect.gen(function* () {
    const id = yield* Schema.decodeEffect(RoundIdSchema)(roundId);
    const codetinder = yield* CodeTinder;
    yield* codetinder.reportLearn(id, { noteId, report });
  }).pipe(
    Effect.provide(CodeTinder.layer),
    Effect.catch(unreported),
    Effect.catchDefect(unreported),
  );
});
