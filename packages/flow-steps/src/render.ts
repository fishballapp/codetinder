import {
  applyLearnAnswer,
  CitationsSchema,
  LEARN_STATE_FILES,
  LearnAnswerSchema,
  LearnedSchema,
  oneLine,
  PRINCIPLES_PATH,
  renderPrinciplesDoc,
  stripCodeFence,
} from '@codetinder/core';
import * as Console from 'effect/Console';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Path from 'effect/Path';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';
import { readCurrentPrinciplesDoc } from './principles-file';
import { logSession } from './session-log';
import { userError } from './user-error';

/** The cards the learn task showed; none when it kept none, so no narrow applies. */
const readCitations = Effect.fn('render.readCitations')(function* () {
  const fs = yield* FileSystem.FileSystem;
  const citations = yield* fs
    .readFileString(LEARN_STATE_FILES.citations)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(CitationsSchema))),
      Effect.option,
    );
  return new Map(Object.entries(Option.getOrElse(citations, () => ({}))));
});

const PAST_TENSE = {
  add: 'added',
  strengthen: 'strengthened',
  weaken: 'weakened',
  drop: 'dropped',
  merge: 'merged',
  narrow: 'narrowed',
  reword: 'reworded',
} as const;

/** What the learn step changed in the doc, for the session log: "2 strengthened, 1 added". */
const describeApplied = (
  operations: readonly { readonly op: keyof typeof PAST_TENSE }[],
  skipped: readonly { readonly operation: { readonly op: keyof typeof PAST_TENSE } }[],
): string => {
  const counts = new Map<keyof typeof PAST_TENSE, number>();
  for (const { op } of operations) counts.set(op, (counts.get(op) ?? 0) + 1);
  for (const { operation } of skipped)
    counts.set(operation.op, (counts.get(operation.op) ?? 1) - 1);
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([op, count]) => `${count} ${PAST_TENSE[op]}`)
    .join(', ');
};

export const runRender = Effect.fn('render.run')(function* (answerFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const answerText = yield* fs
    .readFileString(answerFile)
    .pipe(Effect.mapError(error => userError(error, `can't read the answer: ${error.message}`)));
  const answer = yield* Schema.decodeEffect(Schema.fromJsonString(LearnAnswerSchema))(
    stripCodeFence(answerText),
  ).pipe(
    Effect.mapError(error => userError(error, `the answer is invalid: ${oneLine(error.message)}`)),
  );
  // The doc as the learn task read it: the rewrite agent hasn't run yet.
  const applied = applyLearnAnswer(
    yield* readCurrentPrinciplesDoc(),
    answer,
    yield* readCitations(),
  );
  if (Result.isFailure(applied)) {
    return yield* userError({ message: `the answer is invalid: ${applied.failure}` });
  }
  const learned = applied.success;
  // On stderr: stdout's last line is the step's verdict, which the flow's router reads.
  yield* Effect.forEach(
    learned.skipped,
    ({ operation, reason }) =>
      Console.error(`not applied: ${operation.op} ${operation.id}: ${reason}`),
    { concurrency: 1 },
  );

  yield* fs.makeDirectory(path.dirname(PRINCIPLES_PATH), { recursive: true }).pipe(Effect.orDie);
  yield* fs
    .writeFileString(PRINCIPLES_PATH, renderPrinciplesDoc(learned.principles))
    .pipe(Effect.orDie);
  // `propose` commits from this copy, out of the rewrite agent's reach, not the doc or the answer:
  // the principles, the operations skipped, and the edits to the team's written rules.
  yield* fs
    .makeDirectory(path.dirname(LEARN_STATE_FILES.principles), { recursive: true })
    .pipe(Effect.orDie);
  yield* fs
    .writeFileString(
      LEARN_STATE_FILES.principles,
      Schema.encodeSync(Schema.fromJsonString(LearnedSchema))(learned),
    )
    .pipe(Effect.orDie);
  const changes = describeApplied(answer.operations, learned.skipped);
  yield* logSession(
    changes === ''
      ? `Left ${PRINCIPLES_PATH} as it was: your swipes confirmed it`
      : `Updated ${PRINCIPLES_PATH}: ${changes}`,
  );
  // The flow's router matches this line exactly.
  yield* Console.log('rendered');
});

export const renderCommand = Command.make(
  'render',
  {
    answerFile: Argument.String('answer-file').pipe(
      Argument.withDescription("The learn step's answer, a JSON file"),
    ),
  },
  ({ answerFile }) => runRender(answerFile),
).pipe(Command.withDescription("Write the principles doc from the learn step's answer"));
