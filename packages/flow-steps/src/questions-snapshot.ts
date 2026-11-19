import { QUESTIONS_SNAPSHOT_FILE, type Question, QuestionSchema } from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Path from 'effect/Path';
import * as Schema from 'effect/Schema';

const SnapshotSchema = Schema.fromJsonString(Schema.Array(QuestionSchema));

/** Keeps the questions generate read, for the checks of its answer and of its correction. */
export const writeQuestionsSnapshot = Effect.fn('questionsSnapshot.write')(function* (
  questions: readonly Question[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* Schema.encodeEffect(SnapshotSchema)(questions).pipe(Effect.orDie);
  yield* fs
    .makeDirectory(path.dirname(QUESTIONS_SNAPSHOT_FILE), { recursive: true })
    .pipe(Effect.orDie);
  yield* fs.writeFileString(QUESTIONS_SNAPSHOT_FILE, text).pipe(Effect.orDie);
});

/**
 * The questions generate read, or none when it couldn't read them: a round is then neither held to
 * the freshness budget nor claims one.
 */
export const readQuestionsSnapshot = Effect.fn('questionsSnapshot.read')(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(QUESTIONS_SNAPSHOT_FILE)
    .pipe(Effect.flatMap(Schema.decodeEffect(SnapshotSchema)), Effect.option);
});

export const removeQuestionsSnapshot = Effect.fn('questionsSnapshot.remove')(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(QUESTIONS_SNAPSHOT_FILE).pipe(Effect.ignore);
});
