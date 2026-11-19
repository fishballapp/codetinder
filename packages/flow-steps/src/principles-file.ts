import {
  PRINCIPLES_PATH,
  parsePrinciplesDoc,
  readCurrentPrinciples,
  WRITTEN_RULES_FILES,
} from '@codetinder/core';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import { userError } from './user-error';

const readDoc = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(PRINCIPLES_PATH).pipe(Effect.orDie))) return '';
  return yield* fs.readFileString(PRINCIPLES_PATH).pipe(Effect.orDie);
});

const docError = (error: { readonly line: number; readonly message: string }) =>
  userError(error, `${PRINCIPLES_PATH}:${error.line}: ${error.message}`);

/** The principles in the doc; none while it doesn't exist. */
export const readPrinciples = Effect.fn('principlesFile.read')(function* () {
  return yield* Effect.fromResult(parsePrinciplesDoc(yield* readDoc)).pipe(
    Effect.mapError(docError),
  );
});

/** The doc as a learn run starts from it: parsed, or edited out of shape, to convert. */
export const readCurrentPrinciplesDoc = Effect.fn('principlesFile.readCurrent')(function* () {
  return yield* Effect.fromResult(readCurrentPrinciples(yield* readDoc)).pipe(
    Effect.mapError(docError),
  );
});

/** The team's written rules the project has. */
export const findWrittenRules = Effect.fn('principlesFile.findWrittenRules')(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.filter(WRITTEN_RULES_FILES, file => fs.exists(file).pipe(Effect.orDie), {
    concurrency: 'unbounded',
  });
});
