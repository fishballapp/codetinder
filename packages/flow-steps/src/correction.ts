import { AnswerCorrectionSchema, CORRECTION_STATE_FILE, oneLine } from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';
import { logSession } from './session-log';
import { TASK_FILE } from './task';

/**
 * The agent's answer failed a check of what it wrote, which it can correct: `reason` is one line,
 * for the note or the log; `error` is all the check found, for the agent.
 */
export type Rejected = {
  readonly _tag: 'Rejected';
  readonly reason: string;
  readonly error: string;
};

export const rejected = (reason: string, error = reason): Rejected => ({
  _tag: 'Rejected',
  reason,
  error,
});

/**
 * Keeps what the correction needs, outside the agent's reach: the task, the answer as the agent
 * wrote it, and the check's error. Whether it could: without it there is no correction.
 */
const keepForCorrection = (answerFile: string, { error }: Rejected) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const correction = yield* Schema.encodeEffect(Schema.fromJsonString(AnswerCorrectionSchema))({
      task: yield* fs.readFileString(TASK_FILE),
      answer: yield* fs.readFileString(answerFile),
      error,
    });
    yield* fs.makeDirectory(path.dirname(CORRECTION_STATE_FILE), { recursive: true });
    yield* fs.writeFileString(CORRECTION_STATE_FILE, correction);
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

/**
 * Hands a rejected answer over for its one correction: keeps it and prints `correct`, for the flow
 * to give the agent the error and its answer, and the next check to decide. Whether it did: an
 * answer it can't keep gets no correction.
 */
export const handOverForCorrection = Effect.fn('correction.handOver')(function* (
  answerFile: string,
  rejection: Rejected,
) {
  if (!(yield* keepForCorrection(answerFile, rejection))) return false;
  yield* Console.error(`the agent corrects its answer once: ${oneLine(rejection.reason)}`);
  yield* logSession(
    `The agent's answer failed a check, so it gets one correction: ${oneLine(rejection.reason)}`,
  );
  yield* Console.log('correct');
  return true;
});
