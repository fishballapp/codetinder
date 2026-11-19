import * as Schema from 'effect/Schema';
import { fence } from './fence';

/**
 * Where the check that rejected an agent's answer keeps it for the one correction, outside the
 * repo. A run is a round or a sweep, never both, so one file serves the generate and sweep agents.
 */
export const CORRECTION_STATE_FILE = '/tmp/codetinder/correction.json';

/** An answer a check rejected: the task it answered, the answer as the agent wrote it, and why. */
export const AnswerCorrectionSchema = Schema.Struct({
  task: Schema.String,
  answer: Schema.String,
  error: Schema.String,
});
export type AnswerCorrection = typeof AnswerCorrectionSchema.Type;

/**
 * The task once more, for its one correction: the answer the agent gave and the check it failed,
 * to fix rather than start over.
 */
export const correctionTask = ({ task, answer, error }: AnswerCorrection): string =>
  `${task}
## Correct your answer

You answered this task once, and CodeTinder's check rejected the answer:

${fence(error)}

Your answer was:

${fence(answer)}

Correct it: fix what the check names, reading the files again with \`read_file\` where it is about
their text, and keep the rest as it was unless the fix needs it to change. Answer with the whole
corrected JSON document, as the schema above asks.
`;
